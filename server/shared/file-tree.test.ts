import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getFileTree,
  permToRwx,
} from '@/shared/file-tree.js';

async function withTree(runTest: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'file-tree-'));
  await mkdir(path.join(root, 'b-dir', 'nested', 'deep'), { recursive: true });
  await mkdir(path.join(root, 'a-dir'));
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'z.txt'), 'hello');
  await writeFile(path.join(root, 'b-dir', 'nested', 'deep', 'leaf.txt'), '');
  await chmod(path.join(root, 'z.txt'), 0o640);
  await symlink(path.join(root, 'z.txt'), path.join(root, 'link.txt'));
  try {
    await runTest(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

//----------------- permToRwx ------------
test('permToRwx renders full permissions as rwx', () => {
  assert.equal(permToRwx(7), 'rwx');
});

test('permToRwx renders no permissions as ---', () => {
  assert.equal(permToRwx(0), '---');
});

test('permToRwx renders read+execute without write', () => {
  assert.equal(permToRwx(5), 'r-x');
});

//----------------- getFileTree ------------
test('getFileTree sorts directories first, then by name, and skips excluded entries', async () => {
  await withTree(async (root) => {
    const tree = await getFileTree(root);
    assert.deepEqual(tree.map((entry) => entry.name), ['a-dir', 'b-dir', 'link.txt', 'z.txt']);
  });
});

test('getFileTree reports size, octal and rwx permissions, and symlinks', async () => {
  await withTree(async (root) => {
    const tree = await getFileTree(root);
    const file = tree.find((entry) => entry.name === 'z.txt');
    assert.equal(file?.type, 'file');
    assert.equal(file?.size, 5);
    assert.equal(file?.permissions, '640');
    assert.equal(file?.permissionsRwx, 'rw-r-----');
    assert.equal(file?.isSymlink, undefined);
    assert.equal(tree.find((entry) => entry.name === 'link.txt')?.isSymlink, true);
  });
});

test('getFileTree stops recursing at maxDepth', async () => {
  await withTree(async (root) => {
    const shallow = await getFileTree(root, 1);
    const nested = shallow.find((entry) => entry.name === 'b-dir')?.children?.[0];
    assert.equal(nested?.name, 'nested');
    assert.equal(nested?.children, undefined);

    const deep = await getFileTree(root, 3);
    const deepDir = deep.find((entry) => entry.name === 'b-dir')?.children?.[0]?.children?.[0];
    assert.deepEqual(deepDir?.children?.map((entry) => entry.name), ['leaf.txt']);
  });
});

test('getFileTree returns an empty list for a missing directory', async () => {
  assert.deepEqual(await getFileTree(path.join(tmpdir(), 'file-tree-missing-dir')), []);
});
