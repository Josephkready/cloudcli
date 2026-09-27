import { spawnAsync } from './spawnAsync.js';

/**
 * Read git configuration from system's global git config
 * @returns {Promise<{git_name: string|null, git_email: string|null}>}
 */
export async function getSystemGitConfig() {
  try {
    const [nameResult, emailResult] = await Promise.all([
      spawnAsync('git', ['config', '--global', 'user.name']).catch(() => ({ stdout: '' })),
      spawnAsync('git', ['config', '--global', 'user.email']).catch(() => ({ stdout: '' }))
    ]);

    return {
      git_name: nameResult.stdout.trim() || null,
      git_email: emailResult.stdout.trim() || null
    };
  } catch (error) {
    return { git_name: null, git_email: null };
  }
}
