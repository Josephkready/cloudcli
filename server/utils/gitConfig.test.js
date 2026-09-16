import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getSystemGitConfig } from './gitConfig.js';

/**
 * These run real `git config --global` processes, pointed at a throwaway file
 * via GIT_CONFIG_GLOBAL so they never read or write the developer's own config.
 *
 * The point is as much wiring as behaviour: nothing else in the suite imports
 * this module, and `server/tsconfig.json` sets `checkJs: false`, so a broken
 * import here would pass typecheck and every other test.
 */

const withGlobalGitConfig = async (contents, run) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-gitconfig-'));
  const configPath = path.join(dir, 'gitconfig');
  await writeFile(configPath, contents, 'utf8');

  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
};

test('getSystemGitConfig reads name and email from the global config', async () => {
  const config = await withGlobalGitConfig(
    '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n',
    getSystemGitConfig,
  );

  assert.deepEqual(config, { git_name: 'Ada Lovelace', git_email: 'ada@example.com' });
});

test('getSystemGitConfig returns nulls when the keys are unset', async () => {
  // `git config --global user.name` exits 1 with empty stdout here. The shared
  // spawnAsync rejects on that, and the per-call `.catch` is what turns it into
  // an empty string rather than letting it reject the whole Promise.all.
  const config = await withGlobalGitConfig('', getSystemGitConfig);

  assert.deepEqual(config, { git_name: null, git_email: null });
});

test('getSystemGitConfig reports each key independently', async () => {
  const config = await withGlobalGitConfig(
    '[user]\n\temail = solo@example.com\n',
    getSystemGitConfig,
  );

  assert.deepEqual(config, { git_name: null, git_email: 'solo@example.com' });
});

test('getSystemGitConfig trims surrounding whitespace to null, not an empty string', async () => {
  const config = await withGlobalGitConfig(
    '[user]\n\tname = "   "\n\temail = "  spaced@example.com  "\n',
    getSystemGitConfig,
  );

  assert.equal(config.git_name, null);
  assert.equal(config.git_email, 'spaced@example.com');
});
