import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLookupMap, extractFirstValidJsonlData } from './utils.js';

test('buildLookupMap skips malformed JSONL and continues with later rows', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lookup-jsonl-'));
  try {
    const filePath = path.join(tempDir, 'history.jsonl');
    await writeFile(filePath, [
      JSON.stringify({ id: 'before', title: 'Before corruption' }),
      '{partially-written',
      JSON.stringify({ id: 'after', title: 'After corruption' }),
    ].join('\n'), 'utf8');

    const lookup = await buildLookupMap(filePath, 'id', 'title');

    assert.deepEqual([...lookup.entries()], [
      ['before', 'Before corruption'],
      ['after', 'After corruption'],
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('extractFirstValidJsonlData finds a matching row after malformed JSONL', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'extract-jsonl-'));
  try {
    const filePath = path.join(tempDir, 'session-index.jsonl');
    await writeFile(filePath, [
      JSON.stringify({ kind: 'ignored' }),
      '{partially-written',
      JSON.stringify({ kind: 'target', value: 'found' }),
    ].join('\n'), 'utf8');

    const extracted = await extractFirstValidJsonlData(filePath, (parsed) => {
      const row = parsed as { kind?: string; value?: string };
      return row.kind === 'target' ? row.value : null;
    });

    assert.equal(extracted, 'found');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
