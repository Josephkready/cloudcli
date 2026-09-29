import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexProviderAuth } from './codex-auth.provider.js';

// checkInstalled() shells out to `${CODEX_CLI_PATH || 'codex'} --version` via
// node:child_process's async execFile, which rejects for a missing
// executable (ENOENT) -- so pointing CODEX_CLI_PATH at a real executable / a
// nonexistent path deterministically controls the "installed" branch
// without touching the real Codex CLI.
const REAL_EXECUTABLE = '/bin/echo';
const MISSING_EXECUTABLE = '/definitely/does/not/exist/codex-cli';

function clearEnv() {
  delete process.env.CODEX_CLI_PATH;
}

async function withHome(fn: (homeDir: string) => Promise<void>) {
  const originalHome = process.env.HOME;
  const homeDir = await mkdtemp(path.join(tmpdir(), 'codex-auth-home-'));
  process.env.HOME = homeDir;
  try {
    await fn(homeDir);
  } finally {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('getStatus reports not-installed when the CLI executable cannot run (ENOENT)', async () => {
  await withHome(async () => {
    clearEnv();
    process.env.CODEX_CLI_PATH = MISSING_EXECUTABLE;
    try {
      const status = await new CodexProviderAuth().getStatus();
      assert.equal(status.installed, false);
    } finally {
      clearEnv();
    }
  });
});

test('getStatus reports installed when the CLI executable exists', async () => {
  await withHome(async () => {
    clearEnv();
    process.env.CODEX_CLI_PATH = REAL_EXECUTABLE;
    try {
      const status = await new CodexProviderAuth().getStatus();
      assert.equal(status.installed, true);
    } finally {
      clearEnv();
    }
  });
});
