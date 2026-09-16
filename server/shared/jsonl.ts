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
    // `destroy()` is load-bearing, and specifically because this is a generator.
    // A bare `for await (const line of rl) { ... break }` releases the
    // descriptor on its own — readline's iterator cleanup handles it — which is
    // what every call site did before this extraction. Wrapping that loop in a
    // generator changes the teardown path: breaking out of the *consumer* loop
    // returns the generator, and the descriptor then survives until GC unless
    // it is destroyed here. Removing this line reintroduces a leak that the
    // pre-extraction code did not have; `jsonl.test.ts` pins it.
    rl.close();
    fileStream.destroy();
  }
}
