import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { buildProviderCliEnv, resolveProviderCliExecutable } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

type AgyCommandStatus = 'ok' | 'timeout' | 'failed';

async function runAgy(
  executable: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeout: number,
): Promise<AgyCommandStatus> {
  try {
    await execFileAsync(executable, args, {
      encoding: 'utf8',
      env,
      timeout,
    });
    return 'ok';
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & { killed?: boolean };
    return commandError.killed || commandError.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
  }
}

export class AntigravityProviderAuth implements IProviderAuth {
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { executable?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.executable = options.executable
      ?? resolveProviderCliExecutable('ANTIGRAVITY_CLI_PATH', 'agy');
    this.env = options.env ?? buildProviderCliEnv();
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installStatus = await runAgy(this.executable, this.env, ['--version'], 5_000);
    if (installStatus !== 'ok') {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: 'Antigravity CLI is not installed',
      };
    }

    const authenticationStatus = await runAgy(this.executable, this.env, ['models'], 20_000);
    const authenticated = authenticationStatus === 'ok';
    const authenticationError = authenticationStatus === 'timeout'
      ? 'Timed out while checking Antigravity authentication'
      : 'Antigravity could not list models; run agy in a terminal to authenticate or inspect its diagnostics';
    return {
      installed: true,
      provider: 'antigravity',
      authenticated,
      email: authenticated ? 'Google account' : null,
      method: authenticated ? 'agy' : null,
      error: authenticated ? undefined : authenticationError,
    };
  }
}
