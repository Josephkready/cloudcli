import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Line-by-line reading of the JSONL transcripts every provider writes.
 *
 * Ten call sites across the session providers, the token-usage reader and the
 * conversation-search service each opened their own read stream, wrapped it in
 * `readline`, skipped blank lines, and wrapped `JSON.parse` in a bare `catch`
 * to tolerate the torn last line a concurrently-writing CLI leaves behind.
 * That is the same twelve lines every time, and the only part that actually
 * differed between them was what to do with a parsed entry.
 */

/**
 * Yields each well-formed JSON value in JSONL text already held in memory.
 *
 * The same blank-skip / parse-or-skip pair as `streamJsonlEntries`, for the
 * readers that work off a string: a bounded tail read, or a history file small
 * enough to slurp whole.
 *
 * `fromEnd` walks newest-first, which is what every one of those readers wants
 * — they scan backwards for the most recent matching row and return on the
 * first hit, so the rest of the file is never parsed.
 */
export function* iterateJsonlLines<T = Record<string, any>>(
  lines: readonly string[],
  options: { fromEnd?: boolean } = {},
): Generator<T> {
  const indices = options.fromEnd
    ? function* () { for (let i = lines.length - 1; i >= 0; i -= 1) yield i; }
    : function* () { for (let i = 0; i < lines.length; i += 1) yield i; };

  for (const index of indices()) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let entry: T;
    try {
      entry = JSON.parse(line) as T;
    } catch {
      // A torn line from a concurrent write. Skip it and keep reading.
      continue;
    }

    yield entry;
  }
}

/**
 * Yields each well-formed JSON object in a JSONL file.
 *
 * Blank lines are skipped, and a line that fails to parse is skipped rather
 * than thrown: these files are read while a provider CLI is appending to them,
 * so a torn final line is expected rather than exceptional.
 *
 * `shouldStop` is checked before each line, for readers that stop early (a
 * result limit, an aborted request). Callers may also just `break` — the
 * generator's `finally` tears the stream down either way.
 */
export async function* streamJsonlEntries<T = Record<string, any>>(
  filePath: string,
  options: { shouldStop?: () => boolean } = {},
): AsyncGenerator<T> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (options.shouldStop?.()) {
        return;
      }

      if (!line.trim()) {
        continue;
      }

      let entry: T;
      try {
        entry = JSON.parse(line) as T;
      } catch {
        // A torn line from a concurrent write. Skip it and keep reading.
        continue;
      }

      yield entry;
    }
  } finally {
    // Reached on early `return`/`break` as well as normal exhaustion.
    //
    // `destroy()` is load-bearing: `rl.close()` alone never destroys the
    // underlying `fs.ReadStream`, and readline's iterator cleanup only calls
    // `rl.close()`. A reader that stops early therefore leaks the descriptor
    // until GC unless the stream is destroyed explicitly.
    //
    // This fixes a real pre-existing leak rather than guarding a new one. The
    // three conversation-search loops previously did a bare
    // `for await (const line of rl) { if (limitReached) break; ... }` with no
    // cleanup at all, and hitting that limit is their normal path — once per
    // session file scanned. It went unnoticed because the leak only appears
    // once the file is big enough that the stream has not already drained by
    // the time of the `break`: measured, a 3-line file leaks nothing and a
    // 200k-line one leaks a descriptor, and real transcripts are the latter.
    // (`extractFirstValidJsonlData` was the one site that got this right — it
    // called `fileStream.close()` explicitly, which this replaces.)
    //
    // `jsonl.test.ts` pins it at both sizes, and the assertion was
    // mutation-checked by deleting this line.
    rl.close();
    fileStream.destroy();
  }
}
