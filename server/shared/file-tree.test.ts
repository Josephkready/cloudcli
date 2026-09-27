import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  expandWorkspacePath,
  getFileTree,
  listDirectChildDirectories,
  permToRwx,
  validateFilename,
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

//----------------- validateFilename ------------
test('validateFilename rejects an empty name', () => {
  assert.deepEqual(validateFilename(''), { valid: false, error: 'Filename cannot be empty' });
});

test('validateFilename rejects a whitespace-only name', () => {
  assert.equal(validateFilename('   ').valid, false);
});

test('validateFilename rejects names with invalid characters', () => {
  assert.equal(validateFilename('foo/bar').valid, false);
  assert.equal(validateFilename('foo:bar').valid, false);
});

test('validateFilename rejects Windows-reserved device names', () => {
  assert.equal(validateFilename('CON').valid, false);
  assert.equal(validateFilename('lpt1').valid, false);
});

test('validateFilename rejects dots-only names', () => {
  assert.equal(validateFilename('...').valid, false);
});

test('validateFilename accepts an ordinary name', () => {
  assert.deepEqual(validateFilename('notes.md'), { valid: true });
});

//----------------- expandWorkspacePath ------------
test('expandWorkspacePath returns the input unchanged when falsy', () => {
  assert.equal(expandWorkspacePath('', '/home/user'), '');
});

test('expandWorkspacePath expands a bare tilde to the workspace root', () => {
  assert.equal(expandWorkspacePath('~', '/home/user'), '/home/user');
});

test('expandWorkspacePath expands a tilde-prefixed path under the workspace root', () => {
  assert.equal(expandWorkspacePath('~/projects/foo', '/home/user'), '/home/user/projects/foo');
});

test('expandWorkspacePath leaves an absolute path untouched', () => {
  assert.equal(expandWorkspacePath('/abs/path', '/home/user'), '/abs/path');
});

//----------------- listDirectChildDirectories ------------
test('listDirectChildDirectories returns only non-excluded child directories', async () => {
  await withTree(async (root) => {
    const entries = await listDirectChildDirectories(root);
    assert.deepEqual(
      entries.map((entry) => entry.name).sort(),
      ['a-dir', 'b-dir'],
    );
    assert.deepEqual(entries.find((entry) => entry.name === 'a-dir'), {
      name: 'a-dir',
      path: path.join(root, 'a-dir'),
      type: 'directory',
    });
  });
});

test('listDirectChildDirectories returns an empty list for a missing directory', async () => {
  assert.deepEqual(await listDirectChildDirectories(path.join(tmpdir(), 'file-tree-missing-dir')), []);
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
