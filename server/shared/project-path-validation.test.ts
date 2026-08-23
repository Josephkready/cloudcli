import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateProjectPath } from '@/shared/utils.js';

test('validateProjectPath rejects lexical traversal and symlinks outside the project', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-project-path-'));
  const projectRoot = path.join(tempRoot, 'project');
  const outsideRoot = path.join(tempRoot, 'outside');
  await mkdir(projectRoot);
  await mkdir(outsideRoot);
  await writeFile(path.join(outsideRoot, 'secret.txt'), 'secret');
  await symlink(path.join(outsideRoot, 'secret.txt'), path.join(projectRoot, 'file-link'));
  await symlink(outsideRoot, path.join(projectRoot, 'dir-link'), 'dir');
  await symlink(path.join(outsideRoot, 'missing.txt'), path.join(projectRoot, 'broken-link'));

  try {
    assert.equal((await validateProjectPath(projectRoot, '../outside/secret.txt')).valid, false);
    assert.equal((await validateProjectPath(projectRoot, 'file-link')).valid, false);
    assert.equal((await validateProjectPath(projectRoot, 'dir-link/new.txt')).valid, false);
    assert.equal((await validateProjectPath(projectRoot, 'broken-link')).valid, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('validateProjectPath allows real new paths and symlinks that stay inside the project', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-project-path-'));
  const projectRoot = path.join(tempRoot, 'project');
  const realDir = path.join(projectRoot, 'real');
  await mkdir(realDir, { recursive: true });
  await symlink(realDir, path.join(projectRoot, 'internal-link'), 'dir');

  try {
    const direct = await validateProjectPath(projectRoot, 'real/nested/new.txt');
    const linked = await validateProjectPath(projectRoot, 'internal-link/new.txt');
    assert.equal(direct.valid, true);
    assert.equal(linked.valid, true);
    assert.equal(direct.resolved, path.join(projectRoot, 'real/nested/new.txt'));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
