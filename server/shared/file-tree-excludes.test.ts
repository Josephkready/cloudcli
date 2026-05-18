import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FILE_TREE_EXCLUDED_DIRS,
  shouldExcludeFileTreeEntry,
} from '@/shared/file-tree-excludes.js';

test('FILE_TREE_EXCLUDED_DIRS includes the high-impact dirs from the dante incident', () => {
  // `.ansible_async` alone accumulated 500k+ files in the bug that motivated
  // this list — its presence here is load-bearing.
  for (const name of ['.ansible_async', '.cache', '.local', '.venv', '__pycache__', 'node_modules']) {
    assert.equal(FILE_TREE_EXCLUDED_DIRS.has(name), true, `${name} must be excluded`);
  }
});

test('FILE_TREE_EXCLUDED_DIRS does not exclude common user-code dirs', () => {
  // Anything users might actually navigate to via the file picker must NOT
  // be in the set. Anchors against silently-hide-the-users-files regressions.
  for (const name of ['src', 'tests', 'docs', 'lib', 'app', 'public', 'README.md', 'package.json']) {
    assert.equal(FILE_TREE_EXCLUDED_DIRS.has(name), false, `${name} must NOT be excluded`);
  }
});

test('shouldExcludeFileTreeEntry returns true for excluded names', () => {
  assert.equal(shouldExcludeFileTreeEntry('node_modules'), true);
  assert.equal(shouldExcludeFileTreeEntry('.git'), true);
  assert.equal(shouldExcludeFileTreeEntry('.venv'), true);
  assert.equal(shouldExcludeFileTreeEntry('worktrees'), true);
});

test('shouldExcludeFileTreeEntry returns false for non-excluded names', () => {
  assert.equal(shouldExcludeFileTreeEntry('src'), false);
  assert.equal(shouldExcludeFileTreeEntry('my-project'), false);
  assert.equal(shouldExcludeFileTreeEntry('.env'), false);  // dotfile but not in list
});

test('shouldExcludeFileTreeEntry is exact-match, not substring', () => {
  // node_modulesABC is NOT node_modules — a user-named dir that happens to
  // start with an excluded name must still show up.
  assert.equal(shouldExcludeFileTreeEntry('node_modulesABC'), false);
  assert.equal(shouldExcludeFileTreeEntry('.gitignore'), false);
  assert.equal(shouldExcludeFileTreeEntry('worktrees-archive'), false);
});
