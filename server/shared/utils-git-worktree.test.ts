import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isGitRepositoryRoot, isGitWorktree } from '@/shared/utils.js';

/*
 * Telling a clone apart from a linked worktree (#344).
 *
 * `isGitRepositoryRoot` deliberately counts both, because both are real
 * checkouts. But the new-conversation picker wants the folders a person thinks
 * of as "my repos", and on a machine running parallel agents the worktrees
 * outnumber them: 21 of the 46 listed spaces were agent worktrees under
 * `.cache/omni-harness/.../wt/*` and `/start-work` scratch branches. Git marks
 * the difference already — a clone has a `.git` directory, a linked worktree (or
 * submodule) has a `.git` *file* holding a gitdir pointer.
 */

const withTempDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudcli-worktree-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('isGitWorktree: true for a linked worktree (.git file)', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/feature\n');
    assert.equal(await isGitWorktree(dir), true);
    // Still a repository — the two predicates describe different things.
    assert.equal(await isGitRepositoryRoot(dir), true);
  });
});

test('isGitWorktree: false for an ordinary clone (.git directory)', async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, '.git'));
    assert.equal(await isGitWorktree(dir), false);
    assert.equal(await isGitRepositoryRoot(dir), true);
  });
});

test('isGitWorktree: false for a plain directory', async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, 'src'));
    assert.equal(await isGitWorktree(dir), false);
  });
});

test('isGitWorktree: false for a path that does not exist', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await isGitWorktree(path.join(dir, 'nope')), false);
  });
});
