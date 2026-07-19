import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Shared image-attachment plumbing for every provider runtime.
 *
 * Uploaded chat images are persisted once in the global `~/.cloudcli/assets`
 * folder and referenced by absolute path everywhere else:
 * - Claude: paths are read back into base64 `image` content blocks.
 * - Codex: paths become `local_image` input items.
 *
 * The chat UI loads them through the dedicated `/api/assets/images/:filename`
 * route, which serves only from this folder.
 */

/** Global storage folder for uploaded chat image attachments. */
export function getGlobalImageAssetsDir(): string {
  return path.join(os.homedir(), '.cloudcli', 'assets');
}

export type ImageAttachmentDescriptor = {
  /** Project-relative (preferred) or absolute path to the stored image. */
  path: string;
  name?: string;
  mimeType?: string;
};

/** Media types the Claude Messages API accepts for base64 image blocks. */
const CLAUDE_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Accepts the loosely-typed `options.images` payload from chat.send and
 * returns only well-formed descriptors. Plain path strings are supported so
 * callers can also pass bare path arrays.
 */
export function normalizeImageDescriptors(images: unknown): ImageAttachmentDescriptor[] {
  if (!Array.isArray(images)) {
    return [];
  }

  const descriptors: ImageAttachmentDescriptor[] = [];
  for (const entry of images) {
    if (typeof entry === 'string' && entry.trim()) {
      descriptors.push({ path: entry.trim() });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const entryPath = typeof record.path === 'string' ? record.path.trim() : '';
      if (!entryPath) {
        continue;
      }
      descriptors.push({
        path: entryPath,
        name: typeof record.name === 'string' ? record.name : undefined,
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
      });
    }
  }
  return descriptors;
}

/** Normalizes Windows separators so stored references stay portable. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Resolves a project-relative image path against the run's working directory. */
export function resolveImageAbsolutePath(cwd: string | undefined, imagePath: string): string {
  if (path.isAbsolute(imagePath)) {
    return imagePath;
  }
  return path.resolve(cwd || process.cwd(), imagePath);
}

function isPathInsideDirectory(candidate: string, directory: string): boolean {
  // resolve + startsWith(root + separator) is the containment idiom CodeQL
  // recognizes as a path-injection barrier, and matches the check used by
  // resolveImageAssetFile in the assets module. The root itself never
  // matches (no trailing separator after resolve), only entries below it.
  const resolvedRoot = path.resolve(directory) + path.sep;
  return path.resolve(candidate).startsWith(resolvedRoot);
}

function getDirectoryPathVariants(directory: string): string[] {
  const resolvedDirectory = path.resolve(directory);
  try {
    const canonicalDirectory = path.resolve(realpathSync(directory));
    return canonicalDirectory === resolvedDirectory
      ? [resolvedDirectory]
      : [resolvedDirectory, canonicalDirectory];
  } catch {
    return [resolvedDirectory];
  }
}

/**
 * Second layer of the image trust boundary (the first is the chat.send filter
 * in the websocket gateway): provider builders only reference files that live
 * in the global upload store or inside the run's working directory — places
 * the agent could already access on its own. Anything else (e.g. `~/.ssh`) is
 * refused, so a caller-supplied descriptor can never leak arbitrary files.
 */
export function isAllowedImageSourcePath(resolvedPath: string, cwd?: string): boolean {
  return [getGlobalImageAssetsDir(), cwd || process.cwd()].some((directory) =>
    getDirectoryPathVariants(directory).some((directoryVariant) =>
      isPathInsideDirectory(resolvedPath, directoryVariant)
    )
  );
}

/**
 * Resolves the media type for one image, preferring the uploaded mime type and
 * falling back to the file extension.
 */
export function resolveImageMediaType(descriptor: ImageAttachmentDescriptor): string | null {
  if (descriptor.mimeType) {
    return descriptor.mimeType;
  }
  const extension = path.extname(descriptor.path).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[extension] || null;
}

/** Maps raw image paths to the attachment shape carried by NormalizedMessage.images. */
export function toImageAttachments(imagePaths: string[]): Array<{ path: string }> {
  return imagePaths.map((imagePath) => ({ path: toPosixPath(imagePath) }));
}

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Builds the Claude user-message content list: the prompt text followed by one
 * base64 `image` block per attachment. Images the Claude API cannot accept
 * (e.g. SVG) or that fail to read are skipped with a warning so the prompt
 * itself still goes through.
 */
export async function buildClaudeUserContent(
  prompt: string,
  images: unknown,
  cwd?: string,
): Promise<ClaudeContentBlock[]> {
  const blocks: ClaudeContentBlock[] = [{ type: 'text', text: prompt }];

  for (const descriptor of normalizeImageDescriptors(images)) {
    const mediaType = resolveImageMediaType(descriptor);
    if (!mediaType || !CLAUDE_IMAGE_MEDIA_TYPES.has(mediaType)) {
      console.warn(`[Images] Skipping unsupported Claude image type for ${descriptor.path}`);
      continue;
    }

    const resolvedPath = resolveImageAbsolutePath(cwd, descriptor.path);
    if (!isAllowedImageSourcePath(resolvedPath, cwd)) {
      console.warn(`[Images] Refusing to read image outside allowed roots: ${descriptor.path}`);
      continue;
    }

    try {
      const canonicalPath = await fs.realpath(resolvedPath);
      if (!isAllowedImageSourcePath(canonicalPath, cwd)) {
        console.warn(`[Images] Refusing to read symlinked image outside allowed roots: ${descriptor.path}`);
        continue;
      }

      const bytes = await fs.readFile(canonicalPath);
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: bytes.toString('base64'),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Images] Failed to read image ${descriptor.path}: ${message}`);
    }
  }

  return blocks;
}

type CodexInputItem =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string };

/**
 * Builds the Codex `runStreamed` input list: prompt text plus one
 * `local_image` item per attachment, resolved to absolute paths so the Codex
 * runtime can read them regardless of its own working directory handling.
 */
export function buildCodexInputItems(prompt: string, images: unknown, cwd?: string): CodexInputItem[] {
  const items: CodexInputItem[] = [{ type: 'text', text: prompt }];
  for (const descriptor of normalizeImageDescriptors(images)) {
    const resolvedPath = resolveImageAbsolutePath(cwd, descriptor.path);
    if (!isAllowedImageSourcePath(resolvedPath, cwd)) {
      // Same trust boundary as buildClaudeUserContent — the Codex runtime
      // reads this file, so it must stay within the allowed roots.
      console.warn(`[Images] Refusing to attach image outside allowed roots: ${descriptor.path}`);
      continue;
    }
    items.push({
      type: 'local_image',
      path: resolvedPath,
    });
  }
  return items;
}
