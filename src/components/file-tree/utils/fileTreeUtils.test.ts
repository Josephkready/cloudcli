import assert from 'node:assert/strict';
import test from 'node:test';

import type { TFunction } from 'i18next';

import type { FileTreeNode } from '../types/types';

import {
  collectExpandedDirectoryPaths,
  filterFileTree,
  formatFileSize,
  formatRelativeTime,
  isImageFile,
} from './fileTreeUtils';

const dir = (name: string, path: string, children: FileTreeNode[]): FileTreeNode => ({
  name,
  type: 'directory',
  path,
  children,
});

const file = (name: string, path: string): FileTreeNode => ({ name, type: 'file', path });

const sampleTree = (): FileTreeNode[] => [
  dir('src', '/src', [
    file('index.ts', '/src/index.ts'),
    dir('utils', '/src/utils', [file('math.ts', '/src/utils/math.ts')]),
  ]),
  file('README.md', '/README.md'),
];

/* ── filterFileTree ──────────────────────────────────────────────────────── */

test('filterFileTree: keeps a leaf and its ancestor directories when the leaf matches', () => {
  // The query is matched as-is; callers lowercase it before calling.
  const result = filterFileTree(sampleTree(), 'math');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'src');
  assert.equal(result[0].children?.[0].name, 'utils');
  assert.equal(result[0].children?.[0].children?.[0].name, 'math.ts');
});

test('filterFileTree: drops branches with no match', () => {
  const result = filterFileTree(sampleTree(), 'nonexistent');
  assert.deepEqual(result, []);
});

test('filterFileTree: a directory matched by name keeps only its own matching children', () => {
  // 'src' matches, but none of its descendants match 'src', so children collapse to [].
  const result = filterFileTree(sampleTree(), 'src');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'src');
  assert.deepEqual(result[0].children, []);
});

/* ── collectExpandedDirectoryPaths ───────────────────────────────────────── */

test('collectExpandedDirectoryPaths: returns every non-empty directory path, depth-first', () => {
  assert.deepEqual(collectExpandedDirectoryPaths(sampleTree()), ['/src', '/src/utils']);
});

test('collectExpandedDirectoryPaths: skips empty directories and files', () => {
  const tree = [dir('empty', '/empty', []), file('a.ts', '/a.ts')];
  assert.deepEqual(collectExpandedDirectoryPaths(tree), []);
});

/* ── formatFileSize ──────────────────────────────────────────────────────── */

test('formatFileSize: zero, undefined, and sub-KB sizes', () => {
  assert.equal(formatFileSize(undefined), '0 B');
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(500), '500 B');
});

test('formatFileSize: scales into KB/MB/GB and trims a trailing .0', () => {
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1024 * 1024), '1 MB');
  assert.equal(formatFileSize(1024 * 1024 * 1024), '1 GB');
});

// Regression for #173: the units array used to stop at GB and the index was
// unclamped, so any size >= 1 TB rendered "1 undefined".
test('formatFileSize: renders TB/PB units instead of "undefined" at large sizes', () => {
  const TB = 1024 ** 4;
  const PB = 1024 ** 5;
  assert.equal(formatFileSize(TB), '1 TB');
  assert.equal(formatFileSize(2 * TB), '2 TB');
  assert.equal(formatFileSize(1.5 * TB), '1.5 TB'); // trailing-.0 trim still applies at TB scale
  assert.equal(formatFileSize(PB), '1 PB');
});

// Past the largest defined unit (>= 1 EB) the index is clamped to PB rather
// than walking off the end of the array into `undefined`.
test('formatFileSize: clamps sizes beyond the largest unit to PB', () => {
  assert.equal(formatFileSize(1024 ** 6), '1024 PB');
});

/* ── isImageFile ─────────────────────────────────────────────────────────── */

test('isImageFile: true for known image extensions, case-insensitive', () => {
  assert.equal(isImageFile('photo.png'), true);
  assert.equal(isImageFile('PHOTO.JPG'), true);
  assert.equal(isImageFile('icon.svg'), true);
});

test('isImageFile: false for non-image or extension-less names', () => {
  assert.equal(isImageFile('notes.txt'), false);
  assert.equal(isImageFile('archive.tar.gz'), false);
  assert.equal(isImageFile('Makefile'), false);
});

/* ── formatRelativeTime ──────────────────────────────────────────────────── */

function recordingT() {
  const calls: Array<{ key: string; count?: number }> = [];
  const t = ((key: string, opts?: { count?: number }) => {
    calls.push({ key, count: opts?.count });
    return opts?.count !== undefined ? `${key}:${opts.count}` : key;
  }) as unknown as TFunction;
  return { t, calls };
}

const secondsAgo = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();

test('formatRelativeTime: returns a dash for a missing date', () => {
  const { t } = recordingT();
  assert.equal(formatRelativeTime(undefined, t), '-');
});

test('formatRelativeTime: buckets into just-now / minutes / hours / days', () => {
  const { t } = recordingT();
  assert.equal(formatRelativeTime(secondsAgo(30), t), 'fileTree.justNow');
  assert.equal(formatRelativeTime(secondsAgo(5 * 60), t), 'fileTree.minAgo:5');
  assert.equal(formatRelativeTime(secondsAgo(5 * 3600), t), 'fileTree.hoursAgo:5');
  assert.equal(formatRelativeTime(secondsAgo(5 * 86400), t), 'fileTree.daysAgo:5');
});

test('formatRelativeTime: falls back to an absolute date past ~30 days without calling t', () => {
  const { t, calls } = recordingT();
  const result = formatRelativeTime(secondsAgo(40 * 86400), t);
  assert.equal(calls.length, 0, 'no i18n bucket key should be requested for old dates');
  assert.ok(result.length > 0 && result !== '-');
});
