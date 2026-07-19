import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mapWithConcurrency, readFileTail } from '@/shared/utils.js';

async function withTempFile(contents: string, run: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'utils-file-scan-'));
  const filePath = path.join(dir, 'transcript.jsonl');
  try {
    await fsp.writeFile(filePath, contents);
    await run(filePath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('readFileTail returns the whole file when it is smaller than the window', async () => {
  await withTempFile('line-1\nline-2\n', async (filePath) => {
    const tail = await readFileTail(filePath, 1024);
    assert.equal(tail, 'line-1\nline-2\n');
  });
});

test('readFileTail returns only the last maxBytes bytes of a large file', async () => {
  // 2000 short lines; each is "line-<n>\n". Only the last window should return.
  const body = Array.from({ length: 2000 }, (_unused, index) => `line-${index}`).join('\n') + '\n';
  await withTempFile(body, async (filePath) => {
    const tail = await readFileTail(filePath, 64);
    assert.ok(Buffer.byteLength(tail, 'utf8') <= 64, 'tail must not exceed the requested window');
    // The very last complete line must be present in the tail.
    assert.ok(tail.includes('line-1999'), 'tail should contain the final line');
    // An early line must NOT be present (proves we did not read the whole file).
    assert.ok(!tail.includes('line-0\n'), 'tail should not contain the head of the file');
  });
});

test('readFileTail of an empty file is an empty string', async () => {
  await withTempFile('', async (filePath) => {
    assert.equal(await readFileTail(filePath, 128), '');
  });
});

test('readFileTail with a zero-byte window returns an empty string', async () => {
  await withTempFile('some content here', async (filePath) => {
    assert.equal(await readFileTail(filePath, 0), '');
  });
});

test('a truncated leading JSONL line in the tail is safely skipped by the parser', async () => {
  // Simulate a huge transcript whose window slices mid-line: the first fragment
  // is not valid JSON, but the trailing complete lines are. This mirrors how the
  // synchronizer tolerates a partial first line.
  const lines = [
    JSON.stringify({ sessionId: 's1', type: 'ping' }),
    JSON.stringify({ sessionId: 's1', type: 'ai-title', aiTitle: 'Real Title' }),
  ];
  const padded = 'x'.repeat(500) + '\n' + lines.join('\n') + '\n';
  await withTempFile(padded, async (filePath) => {
    const tail = await readFileTail(filePath, 200);
    const parsedTitles = tail
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line) as { type?: string; aiTitle?: string };
        } catch {
          return null;
        }
      })
      .filter((value): value is { type?: string; aiTitle?: string } => value !== null);
    assert.equal(parsedTitles.at(-1)?.aiTitle, 'Real Title');
  });
});

test('mapWithConcurrency preserves input order in results', async () => {
  const items = [10, 20, 30, 40, 50];
  const results = await mapWithConcurrency(items, 2, async (value) => value * 2);
  assert.deepEqual(results, [20, 40, 60, 80, 100]);
});

test('mapWithConcurrency never exceeds the concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 20 }, (_unused, index) => index);

  await mapWithConcurrency(items, 4, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return value;
  });

  assert.ok(maxActive <= 4, `expected at most 4 concurrent workers, saw ${maxActive}`);
});

test('mapWithConcurrency handles an empty input list', async () => {
  const results = await mapWithConcurrency([], 4, async (value) => value);
  assert.deepEqual(results, []);
});

test('mapWithConcurrency clamps a non-positive concurrency to at least one worker', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 0, async (value) => value + 1);
  assert.deepEqual(results, [2, 3, 4]);
});
