import assert from 'node:assert/strict';
import test from 'node:test';

import { expandWorkspacePath, permToRwx, validateFilename } from '@/shared/file-tree.js';

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
