import assert from 'node:assert/strict';
import test from 'node:test';

import type { GitStatusResponse } from '../types/types';

import {
  getAllChangedFiles,
  getChangedFileCount,
  hasChangedFiles,
  getStatusLabel,
  getStatusBadgeClass,
  parseCommitFiles,
} from './gitPanelUtils';

// ── status-summary helpers (drive the Changes badge + list) ────────────────

const status = (over: Partial<GitStatusResponse> = {}): GitStatusResponse => ({
  modified: [],
  added: [],
  deleted: [],
  untracked: [],
  ...over,
});

test('getAllChangedFiles flattens the M/A/D/U groups in a stable order', () => {
  const result = getAllChangedFiles(
    status({ modified: ['m.ts'], added: ['a.ts'], deleted: ['d.ts'], untracked: ['u.ts'] }),
  );
  // FILE_STATUS_GROUPS order is modified, added, deleted, untracked.
  assert.deepEqual(result, ['m.ts', 'a.ts', 'd.ts', 'u.ts']);
});

test('getAllChangedFiles tolerates a null status and missing groups', () => {
  assert.deepEqual(getAllChangedFiles(null), []);
  assert.deepEqual(getAllChangedFiles(status({ modified: undefined, added: ['a.ts'] })), ['a.ts']);
});

test('getChangedFileCount / hasChangedFiles reflect the flattened total', () => {
  const s = status({ modified: ['a', 'b'], untracked: ['c'] });
  assert.equal(getChangedFileCount(s), 3);
  assert.equal(hasChangedFiles(s), true);
  assert.equal(getChangedFileCount(null), 0);
  assert.equal(hasChangedFiles(null), false);
  assert.equal(hasChangedFiles(status()), false);
});

test('getStatusLabel maps known codes and falls back to the raw code', () => {
  assert.equal(getStatusLabel('M'), 'Modified');
  assert.equal(getStatusLabel('A'), 'Added');
  assert.equal(getStatusLabel('D'), 'Deleted');
  assert.equal(getStatusLabel('U'), 'Untracked');
  assert.equal(getStatusLabel('X' as never), 'X');
});

test('getStatusBadgeClass returns a distinct class per code and falls back to U', () => {
  assert.match(getStatusBadgeClass('A'), /green/);
  assert.match(getStatusBadgeClass('D'), /red/);
  assert.notEqual(getStatusBadgeClass('A'), getStatusBadgeClass('D'));
  // Unknown code -> the 'U' badge class, not undefined.
  assert.equal(getStatusBadgeClass('Z' as never), getStatusBadgeClass('U'));
});

// ── parseCommitFiles: the `git show` multi-file diff parser ─────────────────

const MODIFIED = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' unchanged context',
  '-removed one',
  '+added one',
  '+added two',
].join('\n');

const ADDED = [
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+alpha',
  '+beta',
].join('\n');

const DELETED = [
  'diff --git a/old/gone.txt b/old/gone.txt',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- a/old/gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-line one',
  '-line two',
].join('\n');

test('parseCommitFiles returns an empty summary for empty / preamble-only output', () => {
  assert.deepEqual(parseCommitFiles(''), {
    files: [],
    totalFiles: 0,
    totalInsertions: 0,
    totalDeletions: 0,
  });
  // Commit metadata with no `diff --git` section yields no files.
  const preambleOnly = 'commit abc123\nAuthor: Someone\n\n    a message\n';
  assert.deepEqual(parseCommitFiles(preambleOnly).files, []);
});

test('parseCommitFiles detects a Modified file and counts +/- lines (ignoring --- / +++)', () => {
  const { files } = parseCommitFiles(`commit abc\n\n    msg\n\n${MODIFIED}\n`);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0], {
    path: 'src/foo.ts',
    directory: 'src/',
    filename: 'foo.ts',
    status: 'M',
    insertions: 2,
    deletions: 1,
  });
});

test('parseCommitFiles detects a new file (status A) and uses the b/ path', () => {
  const [file] = parseCommitFiles(ADDED).files;
  assert.equal(file.status, 'A');
  assert.equal(file.path, 'new.txt');
  assert.equal(file.directory, '');
  assert.equal(file.filename, 'new.txt');
  assert.equal(file.insertions, 2);
  // `--- /dev/null` is skipped, so a pure add has zero deletions.
  assert.equal(file.deletions, 0);
});

test('parseCommitFiles detects a deleted file (status D) and uses the a/ path', () => {
  const [file] = parseCommitFiles(DELETED).files;
  assert.equal(file.status, 'D');
  // For a delete the surviving path is the a/ side, split into dir + filename.
  assert.equal(file.path, 'old/gone.txt');
  assert.equal(file.directory, 'old/');
  assert.equal(file.filename, 'gone.txt');
  assert.equal(file.deletions, 2);
  assert.equal(file.insertions, 0);
});

test('parseCommitFiles aggregates totals across several files', () => {
  const summary = parseCommitFiles([MODIFIED, ADDED, DELETED].join('\n'));
  assert.equal(summary.totalFiles, 3);
  assert.deepEqual(
    summary.files.map((f) => f.status),
    ['M', 'A', 'D'],
  );
  assert.equal(summary.totalInsertions, 2 + 2 + 0);
  assert.equal(summary.totalDeletions, 1 + 0 + 2);
});

test('parseCommitFiles skips a section whose header is not a/… b/…', () => {
  const malformed = 'diff --git nonsense header\nindex 1..2\n+ignored\n';
  assert.deepEqual(parseCommitFiles(malformed).files, []);
  // A malformed section between two valid ones does not derail the valid files.
  const mixed = [MODIFIED, malformed, ADDED].join('\n');
  const summary = parseCommitFiles(mixed);
  assert.deepEqual(
    summary.files.map((f) => f.filename),
    ['foo.ts', 'new.txt'],
  );
});
