/**
 * Read ONE named credential out of a protected env file.
 *
 * The point is what it does *not* do. A systemd `EnvironmentFile=` sources the
 * whole file into the process environment, and cloudcli hands its own
 * environment to every agent it spawns — so sourcing a shared credential file
 * would put every unrelated secret in it into every agent. Naming the single
 * variable to read keeps the deployment free to reuse one protected file while
 * only the key this service needs ever enters the process.
 *
 * dante-config asserts this: `cloudcli.service` is tested to contain no
 * `EnvironmentFile=` directive at all, only `*_API_KEY_FILE` paths.
 */
import { readFileSync } from 'node:fs';

/**
 * Extract the first of `names` that the file contents define.
 *
 * @param contents Raw text of an env-style file.
 * @param names Variable names to look for, in priority order.
 * @returns The value, or '' when none of the names are present.
 */
export function readKeyFromContents(contents: string, names: readonly string[]): string {
  for (const name of names) {
    for (const line of contents.split(/\r?\n/)) {
      // Tolerate `export KEY=...`, which a file meant to be shell-sourced uses
      // and a systemd EnvironmentFile does not. Silently finding no key because
      // of that prefix would surface only as "no API key configured".
      const trimmed = line.trim().replace(/^export\s+/, '');
      if (!trimmed.startsWith(`${name}=`)) continue;
      const value = trimmed.slice(name.length + 1).trim();
      // Tolerate `KEY="value"` / `KEY='value'`, which shells and systemd both allow.
      const unquoted = value.replace(/^(["'])(.*)\1$/, '$2').trim();
      if (unquoted) return unquoted;
    }
  }
  return '';
}

/**
 * Same, reading from a path. A missing or unreadable file is '' plus a warning
 * rather than a throw: the caller's feature degrades (the key is simply absent)
 * and that must not take down the request or the process.
 *
 * @param file Path to the env-style file.
 * @param names Variable names to look for, in priority order.
 * @param label Prefix for the warning, e.g. 'voice'.
 */
export function readKeyFromFile(
  file: string,
  names: readonly string[],
  label: string,
): string {
  try {
    return readKeyFromContents(readFileSync(file, 'utf8'), names);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${label}] Could not read ${file}: ${message}`);
    return '';
  }
}
