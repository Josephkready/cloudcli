import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { buildProviderCliEnv, resolveProviderCliExecutable } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

async function runAgy(args: string[], timeout: number): Promise<boolean> {
  try {
    await execFileAsync(resolveProviderCliExecutable('ANTIGRAVITY_CLI_PATH', 'agy'), args, {
      encoding: 'utf8',
      env: buildProviderCliEnv(),
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

export class AntigravityProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = await runAgy(['--version'], 5_000);
    if (!installed) {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: 'Antigravity CLI is not installed',
      };
    }

    const authenticated = await runAgy(['models'], 20_000);
    return {
      installed: true,
      provider: 'antigravity',
      authenticated,
      email: authenticated ? 'Google account' : null,
      method: authenticated ? 'agy' : null,
      error: authenticated ? undefined : 'Run agy in a terminal to authenticate',
    };
  }
}
