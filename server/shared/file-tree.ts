/**
 * Filesystem-tree helpers shared by the folder-picker (`/api/browse-filesystem`)
 * and the project file-explorer (`/api/projects/:projectId/files`) endpoints.
 *
 * Extracted from server/index.js so the pure pieces (permToRwx, validateFilename,
 * expandWorkspacePath) are independently unit-testable, and the recursive
 * getFileTree walk — including its bounded fs-concurrency limiter — has a
 * single home instead of living inline in the entry point.
 */
import { promises as fsPromises } from 'fs';
import path from 'path';

import { shouldExcludeFileTreeEntry } from './file-tree-excludes.js';

export type DirectoryEntry = {
  name: string;
  path: string;
  type: 'directory';
};

export type FileTreeEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
  modified?: string | null;
  isSymlink?: boolean;
  permissions?: string;
  permissionsRwx?: string;
  children?: FileTreeEntry[];
};

/** Converts a 3-bit unix permission value (0-7) to its "rwx" string form. */
export function permToRwx(perm: number): string {
  const r = perm & 4 ? 'r' : '-';
  const w = perm & 2 ? 'w' : '-';
  const x = perm & 1 ? 'x' : '-';
  return r + w + x;
}

/** Validates a candidate file/directory name for the file-explorer's create/rename endpoints. */
export function validateFilename(name: string | undefined | null): { valid: boolean; error?: string } {
  if (!name || !name.trim()) {
    return { valid: false, error: 'Filename cannot be empty' };
  }
  // Check for invalid characters (Windows + Unix)
  const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
  if (invalidChars.test(name)) {
    return { valid: false, error: 'Filename contains invalid characters' };
  }
  // Check for reserved names (Windows)
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reserved.test(name)) {
    return { valid: false, error: 'Filename is a reserved name' };
  }
  // Check for dots only
  if (/^\.+$/.test(name)) {
    return { valid: false, error: 'Filename cannot be only dots' };
  }
  return { valid: true };
}

/** Expands a leading `~` in a browse/create-folder input path to the given workspace root. */
export function expandWorkspacePath(inputPath: string, workspacesRoot: string): string {
  if (!inputPath) return inputPath;
  if (inputPath === '~') {
    return workspacesRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspacesRoot, inputPath.slice(2));
  }
  return inputPath;
}

/**
 * Lightweight directory listing for the folder-picker UI: only the immediate
 * child directories of `dirPath`, with no per-entry stat() call. See the
 * `/api/browse-filesystem` handler for the perf rationale (issue #1).
 */
export async function listDirectChildDirectories(dirPath: string): Promise<DirectoryEntry[]> {
  let entries;
  try {
    entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') {
      console.error('Error reading directory:', error);
    }
    return [];
  }

  const directories: DirectoryEntry[] = [];
  for (const entry of entries) {
    // Skip heavy build/VCS/cache directories — same filter as getFileTree
    // so the two listings stay consistent.
    if (shouldExcludeFileTreeEntry(entry.name)) continue;

    if (!entry.isDirectory()) continue;

    directories.push({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      type: 'directory',
    });
  }
  return directories;
}

const DEFAULT_FS_CONCURRENCY = 64;
const parsedFsConcurrency = Number.parseInt(process.env.FS_CONCURRENCY || '', 10);
const FS_CONCURRENCY = Number.isFinite(parsedFsConcurrency) && parsedFsConcurrency > 0
  ? parsedFsConcurrency
  : DEFAULT_FS_CONCURRENCY;
let activeFsOperations = 0;
const pendingFsOperations: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (activeFsOperations < FS_CONCURRENCY) {
    activeFsOperations += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    pendingFsOperations.push(resolve);
  });
}

function release(): void {
  const next = pendingFsOperations.shift();
  if (next) {
    next();
    return;
  }

  activeFsOperations = Math.max(0, activeFsOperations - 1);
}

/**
 * Recursively walks a project directory, bounded by `maxDepth`, to build the
 * tree the file-explorer renders. Every entry is stat'd in parallel (bounded
 * by the FS_CONCURRENCY limiter above) rather than serially, which is what
 * keeps this responsive on high-latency filesystems (NFS/SMB).
 */
export async function getFileTree(
  dirPath: string,
  maxDepth = 3,
  currentDepth = 0,
  showHidden = true,
): Promise<FileTreeEntry[]> {
  let entries;
  try {
    await acquire();
    try {
      entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    } finally {
      release();
    }
  } catch (error: any) {
    // Only log non-permission errors to avoid spam
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') {
      console.error('Error reading directory:', error);
    }
    return [];
  }

  // Skip heavy build / VCS / cache / language-tooling entries. The list lives
  // in server/shared/file-tree-excludes.ts so the folder-picker and this
  // recursive walk stay in sync.
  const filteredEntries = entries.filter((entry) => !shouldExcludeFileTreeEntry(entry.name));

  // Process every entry in parallel. On high-latency filesystems (NFS/SMB)
  // serial stat() was the real bottleneck — issuing them concurrently lets
  // the kernel pipeline the round-trips and the recursive calls overlap too.
  const items = await Promise.all(filteredEntries.map(async (entry) => {
    const itemPath = path.join(dirPath, entry.name);
    const item: FileTreeEntry = {
      name: entry.name,
      path: itemPath,
      type: entry.isDirectory() ? 'directory' : 'file',
    };

    // Get file stats for additional metadata
    try {
      await acquire();
      try {
        const stats = await fsPromises.lstat(itemPath);
        item.size = stats.size;
        item.modified = stats.mtime.toISOString();

        // Mark symlinks so UI can distinguish them
        if (stats.isSymbolicLink()) {
          item.isSymlink = true;
        }

        // Convert permissions to rwx format
        const mode = stats.mode;
        const ownerPerm = (mode >> 6) & 7;
        const groupPerm = (mode >> 3) & 7;
        const otherPerm = mode & 7;
        item.permissions =
          ((mode >> 6) & 7).toString() +
          ((mode >> 3) & 7).toString() +
          (mode & 7).toString();
        item.permissionsRwx =
          permToRwx(ownerPerm) +
          permToRwx(groupPerm) +
          permToRwx(otherPerm);
      } finally {
        release();
      }
    } catch {
      // If stat fails, provide default values
      item.size = 0;
      item.modified = null;
      item.permissions = '000';
      item.permissionsRwx = '---------';
    }

    if (entry.isDirectory() && currentDepth < maxDepth) {
      // Recurse. Let readdir's own EACCES bubble up through the catch in
      // the recursive call rather than doing a separate access() probe
      // (which doubled the round-trip count on SMB without adding info).
      // The recursive call starts with a bounded readdir; holding a permit
      // for the whole subtree can deadlock when sibling directories are
      // waiting on their own children.
      item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, showHidden);
    }

    return item;
  }));

  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}
