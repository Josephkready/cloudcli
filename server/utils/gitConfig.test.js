import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getSystemGitConfig } from './gitConfig.js';
import { spawnAsync } from './spawnAsync.js';

/**
 * Nothing else in the suite imports this module, and `server/tsconfig.json`
 * sets `checkJs: false`, so a broken import in its `spawnAsync` wiring would
 * pass typecheck and every other test. These run it for real.
 *
 * `git` is genuinely absent in the CI container (`node:22-slim` ships without
 * it), which is why the contract test below is the one that must always run:
 * a deploy with no git on PATH has to degrade to nulls, not throw. The cases
 * that read an actual config file are skipped where there is no git to read it.
 */

const hasGit = await spawnAsync('git', ['--version']).then(() => true, () => false);
const needsGit = hasGit ? {} : { skip: 'git is not installed in this environment' };

/**
 * Points `git config --global` at a throwaway file so these never read or write
 * the developer's own config. Both knobs are set because they cover different
 * git versions: `GIT_CONFIG_GLOBAL` landed in 2.32, `HOME` works everywhere.
 */
const withGlobalGitConfig = async (contents, run) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-gitconfig-'));
  await writeFile(path.join(dir, '.gitconfig'), contents, 'utf8');

  const previous = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, '.gitconfig');
  process.env.HOME = dir;
  delete process.env.XDG_CONFIG_HOME;

  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
};

test('getSystemGitConfig degrades to nulls instead of throwing', async () => {
  // Runs everywhere. Where git is missing (the CI container) this is the
  // git-absent path: spawnAsync rejects with ENOENT, the per-call `.catch`
  // absorbs it, and the caller still gets the documented shape.
  const config = await getSystemGitConfig();

  assert.deepEqual(Object.keys(config).sort(), ['git_email', 'git_name']);
  for (const value of Object.values(config)) {
    assert.ok(value === null || typeof value === 'string', `unexpected value: ${String(value)}`);
    assert.notEqual(value, '', 'an unset key must be null, never an empty string');
  }
});

test('getSystemGitConfig reads name and email from the global config', needsGit, async () => {
  const config = await withGlobalGitConfig(
    '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n',
    getSystemGitConfig,
  );

  // Exact strings, so the trailing newline `git config` always prints proves
  // the `.trim()` actually runs.
  assert.deepEqual(config, { git_name: 'Ada Lovelace', git_email: 'ada@example.com' });
});

test('getSystemGitConfig returns nulls when the keys are unset', needsGit, async () => {
  // `git config --global user.name` exits 1 with empty stdout here. The shared
  // spawnAsync rejects on that, and the per-call `.catch` is what keeps one
  // missing key from rejecting the whole `Promise.all`.
  const config = await withGlobalGitConfig('', getSystemGitConfig);

  assert.deepEqual(config, { git_name: null, git_email: null });
});

test('getSystemGitConfig reports each key independently', needsGit, async () => {
  const config = await withGlobalGitConfig(
    '[user]\n\temail = solo@example.com\n',
    getSystemGitConfig,
  );

  assert.deepEqual(config, { git_name: null, git_email: 'solo@example.com' });
});
