import assert from 'node:assert/strict';
import { mkdtemp, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { iterateJsonlLines, streamJsonlEntries } from '@/shared/jsonl.js';

const withJsonlFile = async (contents: string, run: (filePath: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-jsonl-'));
  const filePath = path.join(dir, 'transcript.jsonl');
  await writeFile(filePath, contents, 'utf8');
  try {
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const collect = async <T>(source: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const entry of source) {
    out.push(entry);
  }
  return out;
};

/* ── streamJsonlEntries ──────────────────────────────────────────────────── */

test('streamJsonlEntries yields every well-formed entry in order', async () => {
  await withJsonlFile('{"n":1}\n{"n":2}\n{"n":3}\n', async (filePath) => {
    assert.deepEqual(await collect(streamJsonlEntries(filePath)), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

test('streamJsonlEntries skips blank and whitespace-only lines', async () => {
  await withJsonlFile('{"n":1}\n\n   \n\t\n{"n":2}\n', async (filePath) => {
    assert.deepEqual(await collect(streamJsonlEntries(filePath)), [{ n: 1 }, { n: 2 }]);
  });
});

test('streamJsonlEntries skips a torn line instead of throwing', async () => {
  // The shape a concurrently-writing CLI leaves behind: a half-written final
  // line. Everything before it must still be read.
  await withJsonlFile('{"n":1}\n{"n":2}\n{"n":3', async (filePath) => {
    assert.deepEqual(await collect(streamJsonlEntries(filePath)), [{ n: 1 }, { n: 2 }]);
  });
});

test('streamJsonlEntries skips a malformed line in the middle and keeps going', async () => {
  await withJsonlFile('{"n":1}\nnot json at all\n{"n":2}\n', async (filePath) => {
    assert.deepEqual(await collect(streamJsonlEntries(filePath)), [{ n: 1 }, { n: 2 }]);
  });
});

test('streamJsonlEntries handles CRLF line endings', async () => {
  await withJsonlFile('{"n":1}\r\n{"n":2}\r\n', async (filePath) => {
    assert.deepEqual(await collect(streamJsonlEntries(filePath)), [{ n: 1 }, { n: 2 }]);
  });
});

test('streamJsonlEntries yields nothing for an empty file', async () => {
  await withJsonlFile('', async (filePath) => {
    assert.deepEqual(await collect(streamJsonlEntries(filePath)), []);
  });
});

test('streamJsonlEntries stops before the line where shouldStop turns true', async () => {
  await withJsonlFile('{"n":1}\n{"n":2}\n{"n":3}\n', async (filePath) => {
    const seen: unknown[] = [];
    for await (const entry of streamJsonlEntries<{ n: number }>(filePath, {
      shouldStop: () => seen.length >= 2,
    })) {
      seen.push(entry);
    }
    assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
  });
});

test('streamJsonlEntries surfaces a missing file as a rejection', async () => {
  const missing = path.join(os.tmpdir(), 'cloudcli-jsonl-does-not-exist', 'nope.jsonl');
  // Callers wrap this in their own try/catch — the generator must not swallow
  // an unreadable file into an empty result, which would be indistinguishable
  // from a transcript with no entries.
  await assert.rejects(collect(streamJsonlEntries(missing)));
});

test('streamJsonlEntries releases the file descriptor when the caller breaks early', {
  // /proc is Linux-only; elsewhere there is no cheap way to ask "is this exact
  // file still open", and a weaker proxy would pass no matter what the code did.
  skip: process.platform !== 'linux' ? 'needs /proc/self/fd' : false,
}, async () => {
  const openCountFor = async (target: string): Promise<number> => {
    const fds = await readdir('/proc/self/fd');
    const resolved = await Promise.all(fds.map((fd) => (
      readlink(path.join('/proc/self/fd', fd)).catch(() => '')
    )));
    return resolved.filter((link) => link === target).length;
  };

  await withJsonlFile('{"n":1}\n{"n":2}\n{"n":3}\n', async (filePath) => {
    assert.equal(await openCountFor(filePath), 0, 'precondition: file not already open');

    for await (const entry of streamJsonlEntries<{ n: number }>(filePath)) {
      if (entry.n === 1) {
        break;
      }
    }

    // Regression guard for the generator teardown path: a plain readline loop
    // released this on its own, so wrapping it must not be a step backwards.
    // The search path abandons a stream per session file as soon as it has
    // enough matches, so early break is the common case there, not an edge one.
    assert.equal(await openCountFor(filePath), 0, 'breaking early must not leak the descriptor');
  });
});

/* ── iterateJsonlLines ───────────────────────────────────────────────────── */

test('iterateJsonlLines yields forward by default', () => {
  const lines = ['{"n":1}', '{"n":2}', '{"n":3}'];
  assert.deepEqual([...iterateJsonlLines(lines)], [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('iterateJsonlLines yields newest-first with fromEnd', () => {
  const lines = ['{"n":1}', '{"n":2}', '{"n":3}'];
  assert.deepEqual([...iterateJsonlLines(lines, { fromEnd: true })], [{ n: 3 }, { n: 2 }, { n: 1 }]);
});

test('iterateJsonlLines skips blank and malformed lines in both directions', () => {
  const lines = ['{"n":1}', '', 'not json', '   ', '{"n":2}'];
  assert.deepEqual([...iterateJsonlLines(lines)], [{ n: 1 }, { n: 2 }]);
  assert.deepEqual([...iterateJsonlLines(lines, { fromEnd: true })], [{ n: 2 }, { n: 1 }]);
});

test('iterateJsonlLines tolerates a sparse array without throwing', () => {
  // `lines[index]?.trim()` guarded against holes before the extraction, so the
  // shared version has to as well.
  const lines = ['{"n":1}', undefined as unknown as string, '{"n":2}'];
  assert.deepEqual([...iterateJsonlLines(lines)], [{ n: 1 }, { n: 2 }]);
});

test('iterateJsonlLines stops parsing once the caller breaks', () => {
  let parsed = 0;
  const lines = ['{"n":1}', '{"n":2}', '{"n":3}'];
  // A reverse scan that returns on its first hit must not pay to parse the
  // rest of the file — that is the whole reason these readers scan backwards.
  for (const entry of iterateJsonlLines<{ n: number }>(lines, { fromEnd: true })) {
    parsed += 1;
    if (entry.n === 3) {
      break;
    }
  }
  assert.equal(parsed, 1);
});

test('iterateJsonlLines yields nothing for an empty list', () => {
  assert.deepEqual([...iterateJsonlLines([])], []);
});
