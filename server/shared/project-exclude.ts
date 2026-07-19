/**
 * Path-based exclusion filter for auto-discovered project paths.
 *
 * The provider session synchronizers (Claude / Codex) walk each
 * provider's transcript directory and upsert a `projects` row for every distinct
 * `cwd` they see. Without a filter that picks up *every* ephemeral worktree the
 * user ever ran the CLI from — `/tmp/myrepo-feature-abc/`, multica workspace
 * dirs, agent worktrees — which clutters the sidebar with paths that no longer
 * exist on disk.
 *
 * Only auto-discovery runs through this filter. Explicit "Create Project" UI
 * flow still goes through `validateWorkspacePath`, which has its own root-dir
 * check.
 */

/**
 * Default exclusion globs. Tuned for the dante-sync convention where every
 * `/start-work` task gets its own `/tmp/<repo>-<branch>-<session>/` worktree,
 * and for in-repo `worktrees/agent-*` patterns used by some agent frameworks.
 */
export const DEFAULT_EXCLUDED_PROJECT_PATH_PATTERNS: readonly string[] = Object.freeze([
  '/tmp/**',
  '**/worktrees/**',
  '**/.dante-sync-clobbered/**',
]);

const PATTERN_DELIMITER = ':';

/**
 * Compile one glob pattern into a `RegExp`. Supported syntax:
 *
 * - `**` matches any characters including `/`
 * - `*` matches any characters except `/`
 * - `?` matches a single character except `/`
 * - all other characters are matched literally
 *
 * The returned regex is anchored (`^…$`) so partial matches do not fire.
 */
export function compileGlobToRegex(pattern: string): RegExp {
  let regex = '^';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      regex += '.*';
      index += 2;
      continue;
    }
    if (char === '*') {
      regex += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      index += 1;
      continue;
    }
    regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  regex += '$';
  return new RegExp(regex);
}

/**
 * Parse a colon-separated list of glob patterns from an env var value.
 * Empty / blank entries are dropped. Returns `null` when the input is
 * `undefined`, so callers can distinguish "env unset" from "env empty".
 */
export function parseEnvExcludePatterns(envValue: string | undefined): string[] | null {
  if (envValue === undefined) {
    return null;
  }
  return envValue
    .split(PATTERN_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve the active set of exclusion patterns from env. When
 * `CLOUDCLI_EXCLUDED_PROJECT_PATHS` is set (even to an empty value) it fully
 * replaces the defaults — empty means "no exclusions". When unset, the
 * built-in defaults apply.
 */
export function getExcludedProjectPathPatterns(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const overrides = parseEnvExcludePatterns(env.CLOUDCLI_EXCLUDED_PROJECT_PATHS);
  if (overrides !== null) {
    return overrides;
  }
  return [...DEFAULT_EXCLUDED_PROJECT_PATH_PATTERNS];
}

/**
 * Returns true when `projectPath` matches at least one pattern in `patterns`.
 * An empty `patterns` array always returns false.
 */
export function shouldExcludeProjectPath(
  projectPath: string,
  patterns: readonly string[] = getExcludedProjectPathPatterns(),
): boolean {
  for (const pattern of patterns) {
    if (compileGlobToRegex(pattern).test(projectPath)) {
      return true;
    }
  }
  return false;
}
