/**
 * Directory-name filter for the file-explorer and folder-picker APIs.
 *
 * The `/api/projects/:projectId/files` endpoint recursively walks a project
 * root up to `maxDepth=10` and stats every file along the way. When the root
 * is something broad like `/home/jkready`, naively descending into every
 * subdirectory walks build artefacts, language caches, IDE state, and
 * runtime housekeeping dirs that the user never wants to browse. In practice
 * this turns the file-tree JSON into hundreds of megabytes and freezes the
 * browser for several seconds per project load.
 *
 * The set below is the conservative "this is always tooling state, never
 * user code" list — dirs that virtually no user opens via a file explorer.
 * Keep additions ergonomically defensible: any name here is silently hidden
 * from the UI, so the cost of a wrong addition is a user wondering "where
 * did my files go?".
 */
export const FILE_TREE_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  // VCS metadata — content is opaque, never navigated via file picker.
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',

  // Build artefacts — regenerated on every build, never user-edited.
  'node_modules',
  'dist',
  'build',
  'target',         // Rust / Java
  'out',            // Next.js / Go
  '.next',
  '.nuxt',

  // Python virtualenvs + caches.
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',

  // Coverage outputs.
  'htmlcov',
  '.coverage',

  // Multi-agent worktree convention (`/start-work` + agent frameworks).
  // The actual code lives in the originating repo; the worktree copies
  // are transient and cluttery if surfaced.
  'worktrees',

  // Heavy user-home state. Without these, walking `~/` ballooned the
  // `/files` response to ~285 MB in practice — `.ansible_async` alone
  // accumulated 500k+ async-runner status files.
  '.cache',
  '.local',
  '.npm',
  '.docker',
  '.gradle',
  '.m2',
  '.terraform',
  '.vscode-server',
  '.ansible_async',
]);

/**
 * Returns true when the given directory entry name should be skipped from
 * file-tree walks. Pure, side-effect-free — safe to call in a hot loop.
 */
export function shouldExcludeFileTreeEntry(name: string): boolean {
  return FILE_TREE_EXCLUDED_DIRS.has(name);
}
