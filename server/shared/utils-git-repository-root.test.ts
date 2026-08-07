import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isGitRepositoryRoot } from '@/shared/utils.js';

/*
 * The folder picker lists repositories only (#309), so this predicate decides
 * what a user can see. The two shapes that must both count are an ordinary
 * clone (`.git` directory) and a linked worktree or submodule (`.git` *file*
 * holding a gitdir pointer) — `~/repos` on a machine running parallel agents is
 * full of the latter.
 */

const withTempDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudcli-gitroot-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('isGitRepositoryRoot: true for an ordinary clone (.git directory)', async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, '.git'));
    assert.equal(await isGitRepositoryRoot(dir), true);
  });
});

test('isGitRepositoryRoot: true for a linked worktree (.git file)', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/feature\n');
    assert.equal(await isGitRepositoryRoot(dir), true);
  });
});

test('isGitRepositoryRoot: false for a plain directory', async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, 'src'));
    assert.equal(await isGitRepositoryRoot(dir), false);
  });
});

test('isGitRepositoryRoot: false for a subdirectory of a repository', async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, '.git'));
    await mkdir(path.join(dir, 'src'));

    // The whole point of #309: `repo/src` must not read as a repository, or the
    // picker is right back to listing every subfolder.
    assert.equal(await isGitRepositoryRoot(path.join(dir, 'src')), false);
  });
});

test('isGitRepositoryRoot: false for a path that does not exist', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await isGitRepositoryRoot(path.join(dir, 'nope')), false);
  });
});
