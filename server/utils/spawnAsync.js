// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

/**
 * Runs a command to completion and buffers its output.
 *
 * `shell: false` is not configurable: every caller passes user-influenced
 * arguments (branch names, file paths, commit refs), and going through a shell
 * would turn those into an injection surface. Three near-identical copies of
 * this used to live in `routes/git.js`, `routes/user.js` and `utils/gitConfig.js`,
 * and only two of them attached stdout/stderr to the rejection — so the same
 * failure produced a useful error in one route and a bare message in another.
 *
 * Rejects with an `Error` carrying `code`, `stdout` and `stderr` on non-zero
 * exit, so callers can report what the command actually said.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import('child_process').SpawnOptions} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => { reject(error); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}
