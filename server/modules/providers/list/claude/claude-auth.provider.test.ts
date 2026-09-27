import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeProviderAuth } from './claude-auth.provider.js';

// checkInstalled() shells out to `${CLAUDE_CLI_PATH} --version` via
// cross-spawn's sync API; resolveClaudeCodeExecutablePath returns
// CLAUDE_CLI_PATH verbatim on non-Windows (see claude-cli-path.ts), so
// pointing it at a real executable / a nonexistent path deterministically
// controls the "installed" branch without touching the real Claude CLI.
const REAL_EXECUTABLE = '/bin/echo';
const MISSING_EXECUTABLE = '/definitely/does/not/exist/claude-cli';

async function withHome(fn: (homeDir: string) => Promise<void>) {
  const originalHome = process.env.HOME;
  const homeDir = await mkdtemp(path.join(tmpdir(), 'claude-auth-home-'));
  process.env.HOME = homeDir;
  try {
    await fn(homeDir);
  } finally {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  }
}

function clearAuthEnv() {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CLI_PATH;
}

test('getStatus reports not-installed when the CLI executable cannot run', async () => {
  clearAuthEnv();
  process.env.CLAUDE_CLI_PATH = MISSING_EXECUTABLE;
  try {
    const auth = new ClaudeProviderAuth();
    const status = await auth.getStatus();
    assert.equal(status.installed, false);
    assert.equal(status.authenticated, false);
    assert.equal(status.error, 'Claude Code CLI is not installed');
  } finally {
    clearAuthEnv();
  }
});

test('getStatus reports authenticated via ANTHROPIC_AUTH_TOKEN', async () => {
  clearAuthEnv();
  process.env.CLAUDE_CLI_PATH = REAL_EXECUTABLE;
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-token';
  try {
    const status = await new ClaudeProviderAuth().getStatus();
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'api_key');
    assert.equal(status.email, 'Auth Token');
    assert.equal(status.error, undefined);
  } finally {
    clearAuthEnv();
  }
});

test('getStatus reports authenticated via ANTHROPIC_API_KEY', async () => {
  clearAuthEnv();
  process.env.CLAUDE_CLI_PATH = REAL_EXECUTABLE;
  process.env.ANTHROPIC_API_KEY = 'sk-key';
  try {
    const status = await new ClaudeProviderAuth().getStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'api_key');
    assert.equal(status.email, 'API Key Auth');
  } finally {
    clearAuthEnv();
  }
});

test('getStatus falls back to ~/.claude/settings.json env values', async () => {
  await withHome(async (homeDir) => {
    clearAuthEnv();
    process.env.CLAUDE_CLI_PATH = REAL_EXECUTABLE;
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });

    await writeFile(
      path.join(homeDir, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'from-settings' } }),
    );
    const viaApiKey = await new ClaudeProviderAuth().getStatus();
    assert.equal(viaApiKey.authenticated, true);
    assert.equal(viaApiKey.email, 'API Key Auth');

    await writeFile(
      path.join(homeDir, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'from-settings-token' } }),
    );
    const viaAuthToken = await new ClaudeProviderAuth().getStatus();
    assert.equal(viaAuthToken.authenticated, true);
    assert.equal(viaAuthToken.email, 'Configured via settings.json');

    clearAuthEnv();
  });
});

test('getStatus treats a malformed settings.json as absent (falls through, does not throw)', async () => {
  await withHome(async (homeDir) => {
    clearAuthEnv();
    process.env.CLAUDE_CLI_PATH = REAL_EXECUTABLE;
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await writeFile(path.join(homeDir, '.claude', 'settings.json'), '{not json');

    const status = await new ClaudeProviderAuth().getStatus();
    // No settings, no credentials file -> missing-credentials error path.
    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /not authenticated|Run claude \/login/);
    clearAuthEnv();
  });
});

test('getStatus reports unauthenticated with a helpful error when no credentials file exists', async () => {
  await withHome(async () => {
    clearAuthEnv();
    process.env.CLAUDE_CLI_PATH = REAL_EXECUTABLE;
    const status = await new ClaudeProviderAuth().getStatus();
    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /Run claude \/login/);
    clearAuthEnv();
  });
});

test('getStatus reads a valid, non-expired OAuth credentials file', async () => {
  await withHome(async (homeDir) => {
    clearAuthEnv();
    process.env.CLAUDE_CLI_PATH = REAL_EXECUTABLE;
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await writeFile(
      path.join(homeDir, '.claude', '.credentials.json'),
      JSON.stringify({
        email: 'alice@example.com',
        claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 1_000_000 },
      }),
    );

    const status = await new ClaudeProviderAuth().getStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'credentials_file');
    assert.equal(status.email, 'alice@example.com');
    clearAuthEnv();
  });
});

test('getStatus reports an expired-login error for a stale OAuth token', async () => {
  await withHome(async (homeDir) => {
    clearAuthEnv();
    process.env.CLAUDE_CLI_PATH = REAL_EXECUTABLE;
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await writeFile(
      path.join(homeDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1_000 } }),
    );

    const status = await new ClaudeProviderAuth().getStatus();
    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /login has expired/);
    clearAuthEnv();
  });
});

test('getStatus reports "not authenticated" when the credentials file has no access token', async () => {
  await withHome(async (homeDir) => {
    clearAuthEnv();
    process.env.CLAUDE_CLI_PATH = REAL_EXECUTABLE;
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await writeFile(
      path.join(homeDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: {} }),
    );

    const status = await new ClaudeProviderAuth().getStatus();
    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /not authenticated|Run claude \/login/);
    clearAuthEnv();
  });
});

test('getStatus reports an unreadable-credentials error for malformed JSON', async () => {
  await withHome(async (homeDir) => {
    clearAuthEnv();
    process.env.CLAUDE_CLI_PATH = REAL_EXECUTABLE;
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await writeFile(path.join(homeDir, '.claude', '.credentials.json'), '{not json');

    const status = await new ClaudeProviderAuth().getStatus();
    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /unreadable/);
    clearAuthEnv();
  });
});
