import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findFilesRecursivelyModifiedAfter } from '@/shared/utils.js';

/**
 * Regression coverage for the incremental session re-index (#97). Provider
 * transcripts are appended across a session's life, so a file created before
 * the last scan but written afterward must still be re-indexed. The helper
 * previously keyed off `birthtime` (creation) and skipped those, leaving stale
 * titles/metadata after a restart. It now keys off `max(mtime, birthtime)`.
 */

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'find-files-modified-'));
}

/** Writes a file, then forces its mtime to `mtime` (birthtime stays at creation). */
async function writeFileWithMtime(filePath: string, mtime: Date): Promise<void> {
  await writeFile(filePath, '{}\n');
  await utimes(filePath, mtime, mtime);
}

test('includes a file appended after the last scan even though it was created before', async () => {
  const dir = await makeTempDir();
  try {
    // birthtime ≈ now (creation), which is before lastScanAt.
    const lastScanAt = new Date(Date.now() + 10_000);
    const appended = path.join(dir, 'appended.jsonl');
    // mtime after lastScanAt: the file changed since the scan and must be picked up.
    await writeFileWithMtime(appended, new Date(Date.now() + 20_000));

    const found = await findFilesRecursivelyModifiedAfter(dir, '.jsonl', lastScanAt);

    assert.deepEqual(found, [appended]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('excludes a file untouched since the last scan', async () => {
  const dir = await makeTempDir();
  try {
    const lastScanAt = new Date(Date.now() + 10_000);
    const stale = path.join(dir, 'stale.jsonl');
    // Both birthtime (≈ now) and mtime (past) are before lastScanAt.
    await writeFileWithMtime(stale, new Date(Date.now() - 20_000));

    const found = await findFilesRecursivelyModifiedAfter(dir, '.jsonl', lastScanAt);

    assert.deepEqual(found, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('full rescan (lastScanAt = null) returns every matching file regardless of timestamps', async () => {
  const dir = await makeTempDir();
  try {
    const older = path.join(dir, 'older.jsonl');
    const newer = path.join(dir, 'newer.jsonl');
    await writeFileWithMtime(older, new Date(Date.now() - 60_000));
    await writeFileWithMtime(newer, new Date(Date.now() + 60_000));

    const found = await findFilesRecursivelyModifiedAfter(dir, '.jsonl', null);

    assert.deepEqual(found.sort(), [newer, older].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recurses into subdirectories', async () => {
  const dir = await makeTempDir();
  try {
    const nested = path.join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    const deep = path.join(nested, 'deep.jsonl');
    await writeFileWithMtime(deep, new Date(Date.now() + 20_000));

    const found = await findFilesRecursivelyModifiedAfter(dir, '.jsonl', new Date(Date.now() + 10_000));

    assert.deepEqual(found, [deep]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ignores files whose extension does not match', async () => {
  const dir = await makeTempDir();
  try {
    const future = new Date(Date.now() + 20_000);
    await writeFileWithMtime(path.join(dir, 'keep.jsonl'), future);
    await writeFileWithMtime(path.join(dir, 'skip.txt'), future);

    const found = await findFilesRecursivelyModifiedAfter(dir, '.jsonl', new Date(Date.now() + 10_000));

    assert.deepEqual(found, [path.join(dir, 'keep.jsonl')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns an empty list for a missing directory instead of throwing', async () => {
  const missing = path.join(os.tmpdir(), 'find-files-modified-does-not-exist-xyz');
  const found = await findFilesRecursivelyModifiedAfter(missing, '.jsonl', null);
  assert.deepEqual(found, []);
});
