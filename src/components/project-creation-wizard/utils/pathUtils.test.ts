import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getParentPath,
  getSuggestionRootPath,
  isCloneWorkflow,
  isSshGitUrl,
  joinFolderPath,
  shouldShowGithubAuthentication,
} from './pathUtils';

/* ── isSshGitUrl ─────────────────────────────────────────────────────────── */

test('isSshGitUrl: detects scp-style and ssh:// URLs, rejects https', () => {
  assert.equal(isSshGitUrl('git@github.com:owner/repo.git'), true);
  assert.equal(isSshGitUrl('ssh://git@example.com/owner/repo.git'), true);
  assert.equal(isSshGitUrl('https://github.com/owner/repo.git'), false);
  assert.equal(isSshGitUrl('http://example.com/repo'), false);
  assert.equal(isSshGitUrl(''), false);
});

test('isSshGitUrl: trims surrounding whitespace before matching', () => {
  assert.equal(isSshGitUrl('   git@github.com:owner/repo.git  '), true);
  assert.equal(isSshGitUrl('\tssh://host/repo'), true);
});

/* ── shouldShowGithubAuthentication ──────────────────────────────────────── */

test('shouldShowGithubAuthentication: true only for a non-empty, non-SSH URL', () => {
  assert.equal(shouldShowGithubAuthentication('https://github.com/owner/repo'), true);
  // SSH URLs authenticate via the key, so the auth prompt is suppressed.
  assert.equal(shouldShowGithubAuthentication('git@github.com:owner/repo.git'), false);
  assert.equal(shouldShowGithubAuthentication(''), false);
  assert.equal(shouldShowGithubAuthentication('   '), false);
});

/* ── isCloneWorkflow ─────────────────────────────────────────────────────── */

test('isCloneWorkflow: true when a URL is present, false when blank', () => {
  assert.equal(isCloneWorkflow('https://github.com/owner/repo'), true);
  assert.equal(isCloneWorkflow('git@github.com:owner/repo.git'), true);
  assert.equal(isCloneWorkflow(''), false);
  assert.equal(isCloneWorkflow('   '), false);
});

/* ── getSuggestionRootPath ───────────────────────────────────────────────── */

test('getSuggestionRootPath: returns the parent directory of a unix path', () => {
  assert.equal(getSuggestionRootPath('/home/user/projects'), '/home/user');
  assert.equal(getSuggestionRootPath('  /home/user/projects  '), '/home/user');
});

test('getSuggestionRootPath: strips the trailing segment of a windows path', () => {
  assert.equal(getSuggestionRootPath('C:\\Users\\foo'), 'C:\\Users');
});

test('getSuggestionRootPath: a windows drive root collapses to `C:\\`', () => {
  // Separator at index 2 (`C:\...`) is the drive root — keep the `C:\` prefix.
  assert.equal(getSuggestionRootPath('C:\\foo'), 'C:\\');
});

test('getSuggestionRootPath: a bare name with no separator falls back to `~`', () => {
  assert.equal(getSuggestionRootPath('foo'), '~');
  assert.equal(getSuggestionRootPath('~'), '~');
  // Root-only path: the sole separator is at index 0 (not > 0), so it also
  // falls through to the `~` default.
  assert.equal(getSuggestionRootPath('/'), '~');
});

/* ── getParentPath ───────────────────────────────────────────────────────── */

test('getParentPath: roots have no parent (null)', () => {
  assert.equal(getParentPath('~'), null);
  assert.equal(getParentPath('/'), null);
  assert.equal(getParentPath('C:\\'), null);
  assert.equal(getParentPath('C:'), null);
});

test('getParentPath: a top-level unix dir has `/` as its parent', () => {
  assert.equal(getParentPath('/home'), '/');
});

test('getParentPath: a nested unix dir returns the directory above it', () => {
  assert.equal(getParentPath('/home/user'), '/home');
  assert.equal(getParentPath('/home/user/projects'), '/home/user');
});

test('getParentPath: windows paths walk up, drive root keeps the `\\`', () => {
  assert.equal(getParentPath('C:\\Users\\foo'), 'C:\\Users');
  // Only the drive letter remains → keep the backslash so it reads as a root.
  assert.equal(getParentPath('C:\\Users'), 'C:\\');
});

/* ── joinFolderPath ──────────────────────────────────────────────────────── */

test('joinFolderPath: joins with `/` for unix paths and trims the folder name', () => {
  assert.equal(joinFolderPath('/home/user', 'proj'), '/home/user/proj');
  assert.equal(joinFolderPath('/home/user', '  proj  '), '/home/user/proj');
});

test('joinFolderPath: collapses any trailing separators on the base', () => {
  assert.equal(joinFolderPath('/home/user/', 'proj'), '/home/user/proj');
  assert.equal(joinFolderPath('/home/user///', 'proj'), '/home/user/proj');
});

test('joinFolderPath: a blank base trims to empty and joins with the default `/`', () => {
  assert.equal(joinFolderPath('   ', 'proj'), '/proj');
});

test('joinFolderPath: uses `\\` only for a pure-backslash windows base', () => {
  assert.equal(joinFolderPath('C:\\Users', 'proj'), 'C:\\Users\\proj');
  // Mixed/forward-slash bases stay on `/`.
  assert.equal(joinFolderPath('C:/Users', 'proj'), 'C:/Users/proj');
});
