// Pure, dependency-free fingerprint cache used by the session synchronizer to
// skip re-reading and re-parsing transcript files whose contents haven't
// changed since they were last scanned. Kept DB-free (like session-title.ts) so
// it unit-tests without the database/native-module import chain.

export type FileFingerprint = {
  /** Modification time in epoch milliseconds. */
  mtimeMs: number;
  /** File size in bytes. */
  size: number;
};

/**
 * In-memory cache keyed by absolute file path and invalidated whenever the
 * file's `(mtimeMs, size)` fingerprint changes.
 *
 * `mtime + size` is a cheap, standard staleness proxy: for local transcript
 * files that only ever grow by appending, a matching fingerprint means the
 * bytes we already parsed are still current, so the expensive read+parse can be
 * skipped. A mismatch (or a never-seen path) is a miss and the caller recomputes.
 */
export class FileFingerprintCache<TValue> {
  private readonly entries = new Map<string, { fingerprint: FileFingerprint; value: TValue }>();

  /**
   * Returns the cached value when `filePath` was stored with an identical
   * fingerprint, otherwise `undefined` (never seen, or the file changed).
   */
  get(filePath: string, fingerprint: FileFingerprint): TValue | undefined {
    const entry = this.entries.get(filePath);
    if (!entry) {
      return undefined;
    }

    if (entry.fingerprint.mtimeMs !== fingerprint.mtimeMs || entry.fingerprint.size !== fingerprint.size) {
      return undefined;
    }

    return entry.value;
  }

  /** Stores `value` for `filePath` under the given fingerprint, replacing any prior entry. */
  set(filePath: string, fingerprint: FileFingerprint, value: TValue): void {
    this.entries.set(filePath, { fingerprint, value });
  }

  /** Number of cached paths (primarily for tests/introspection). */
  get size(): number {
    return this.entries.size;
  }

  /** Drops every cached entry. */
  clear(): void {
    this.entries.clear();
  }
}
