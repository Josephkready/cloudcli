import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CachedTranscript } from './transcriptCache.pure';

/**
 * jsdom implements no IndexedDB at all (not even a throwing stub), and this
 * project has no `fake-indexeddb` dependency, so this file carries a small,
 * purpose-built fake tailored exactly to the subset of the IndexedDB API that
 * `transcriptCache.ts` actually calls: `open`, `onupgradeneeded` creating one
 * object store + one index, a readonly/readwrite `transaction` with
 * `oncomplete`/`onerror`/`onabort`, `get`/`put`/`delete`, and
 * `index(...).openKeyCursor()` with `primaryKey`/`key`/`continue()`. It is not
 * a general IndexedDB polyfill — it exists to exercise the real control flow
 * in `transcriptCache.ts` (success paths, error paths, and the eviction
 * cursor scan) against something that behaves like a real async database.
 */

type Handler = (() => void) | null;

class FakeRequest<T = unknown> {
  result: T | undefined;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeCursor {
  constructor(
    public primaryKey: string,
    public key: number,
    private readonly advance: () => void,
  ) {}
  continue() {
    this.advance();
  }
}

class FakeIndex {
  constructor(
    private readonly store: FakeObjectStore,
    private readonly keyPath: string,
    private readonly failCursor: boolean,
  ) {}

  openKeyCursor(): FakeRequest<FakeCursor | null> {
    const req = new FakeRequest<FakeCursor | null>();
    if (this.failCursor) {
      queueMicrotask(() => req.onerror?.());
      return req;
    }
    const entries = [...this.store.data.values()]
      .map((v) => ({
        primaryKey: String((v as Record<string, unknown>)[this.store.keyPath]),
        key: Number((v as Record<string, unknown>)[this.keyPath]),
      }))
      .sort((a, b) => a.key - b.key);
    let i = 0;
    const step = () => {
      queueMicrotask(() => {
        if (i >= entries.length) {
          req.result = null;
        } else {
          const e = entries[i];
          i += 1;
          req.result = new FakeCursor(e.primaryKey, e.key, step);
        }
        req.onsuccess?.();
      });
    };
    step();
    return req;
  }
}

class FakeObjectStore {
  data = new Map<string, unknown>();
  indexes = new Map<string, string>();
  constructor(
    public keyPath: string,
    private readonly opts: { failIndex?: boolean; failCursor?: boolean; failGet?: boolean } = {},
  ) {}

  createIndex(name: string, keyPath: string) {
    this.indexes.set(name, keyPath);
  }

  index(name: string): FakeIndex {
    if (this.opts.failIndex) throw new Error('no such index (fake)');
    const keyPath = this.indexes.get(name);
    if (!keyPath) throw new Error(`unknown index ${name}`);
    return new FakeIndex(this, keyPath, Boolean(this.opts.failCursor));
  }

  get(key: string): FakeRequest {
    if (this.opts.failGet) throw new Error('get threw synchronously (fake)');
    const req = new FakeRequest();
    queueMicrotask(() => {
      req.result = this.data.get(key);
      req.onsuccess?.();
    });
    return req;
  }

  put(entry: Record<string, unknown>, skipCommit: boolean): FakeRequest {
    if (!skipCommit) this.data.set(String(entry[this.keyPath]), entry);
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  delete(key: string, skipCommit: boolean): FakeRequest {
    if (!skipCommit) this.data.delete(key);
    const req = new FakeRequest();
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
}

/** Wraps a store so writes within an aborting transaction never actually commit. */
class FakeTransactionStoreView {
  constructor(
    private readonly store: FakeObjectStore,
    private readonly shouldAbort: boolean,
  ) {}
  get(key: string) {
    return this.store.get(key);
  }
  put(entry: Record<string, unknown>) {
    return this.store.put(entry, this.shouldAbort);
  }
  delete(key: string) {
    return this.store.delete(key, this.shouldAbort);
  }
  index(name: string) {
    return this.store.index(name);
  }
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  constructor(
    private readonly store: FakeObjectStore,
    private readonly shouldAbort: boolean,
  ) {
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (this.shouldAbort) {
          this.onabort?.();
        } else {
          this.oncomplete?.();
        }
      });
    });
  }
  objectStore(_name: string): FakeTransactionStoreView {
    return new FakeTransactionStoreView(this.store, this.shouldAbort);
  }
}

class FakeDatabase {
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  stores = new Map<string, FakeObjectStore>();
  constructor(
    private readonly txOptions: {
      failIndex?: boolean;
      failCursor?: boolean;
      failGet?: boolean;
      abortWrites?: boolean;
      throwOnReadwriteTx?: boolean;
    } = {},
  ) {}

  createObjectStore(name: string, opts: { keyPath: string }): FakeObjectStore {
    const store = new FakeObjectStore(opts.keyPath, {
      failIndex: this.txOptions.failIndex,
      failCursor: this.txOptions.failCursor,
      failGet: this.txOptions.failGet,
    });
    this.stores.set(name, store);
    return store;
  }

  transaction(name: string, mode: 'readonly' | 'readwrite'): FakeTransaction {
    if (this.txOptions.throwOnReadwriteTx && mode === 'readwrite') {
      throw new Error('transaction() threw synchronously (fake)');
    }
    const store = this.stores.get(name);
    if (!store) throw new Error(`unknown store ${name}`);
    return new FakeTransaction(store, Boolean(this.txOptions.abortWrites && mode === 'readwrite'));
  }
}

interface FakeIdbFactoryOptions {
  /** Simulate `indexedDB.open` throwing synchronously. */
  throwOnOpen?: boolean;
  /** Simulate the open request firing `onerror`. */
  errorOnOpen?: boolean;
  /** Simulate the open request firing `onblocked`. */
  blockedOnOpen?: boolean;
  /** Reuse the same underlying database across opens (persistence). */
  sharedDb?: FakeDatabase;
  failIndex?: boolean;
  failCursor?: boolean;
  failGet?: boolean;
  abortWrites?: boolean;
  throwOnReadwriteTx?: boolean;
}

function installFakeIndexedDb(opts: FakeIdbFactoryOptions = {}) {
  let created = false;
  const db =
    opts.sharedDb ??
    new FakeDatabase({
      failIndex: opts.failIndex,
      failCursor: opts.failCursor,
      failGet: opts.failGet,
      abortWrites: opts.abortWrites,
      throwOnReadwriteTx: opts.throwOnReadwriteTx,
    });

  const fakeIndexedDb = {
    open() {
      const req = new FakeRequest<FakeDatabase>() as FakeRequest<FakeDatabase> & {
        onupgradeneeded: Handler;
        onblocked: Handler;
      };
      req.onupgradeneeded = null;
      req.onblocked = null;
      if (opts.throwOnOpen) {
        throw new Error('indexedDB.open threw (fake)');
      }
      queueMicrotask(() => {
        if (opts.errorOnOpen) {
          req.onerror?.();
          return;
        }
        if (opts.blockedOnOpen) {
          req.onblocked?.();
          return;
        }
        req.result = db;
        const isNew = !created;
        if (isNew) {
          created = true;
          req.onupgradeneeded?.();
        }
        queueMicrotask(() => req.onsuccess?.());
      });
      return req;
    },
  };

  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: fakeIndexedDb,
  });

  return db;
}

function removeIndexedDb() {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: undefined,
  });
}

function throwingIndexedDbGetter() {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      throw new Error('accessing indexedDB threw (fake, sandboxed context)');
    },
  });
}

function transcript(overrides: Partial<CachedTranscript> = {}): CachedTranscript {
  return {
    sessionId: 's1',
    provider: 'claude',
    serverMessages: [],
    hasMore: false,
    offset: 0,
    total: 0,
    fingerprint: '0',
    cachedAt: Date.now(),
    ...overrides,
  };
}

/** Import a fresh module instance so its module-scoped `dbPromise` isn't stale. */
async function importFresh() {
  vi.resetModules();
  return import('./transcriptCache');
}

const originalIndexedDb = (globalThis as unknown as { indexedDB?: unknown }).indexedDB;

afterEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: originalIndexedDb,
  });
});

describe('transcriptCache — no IndexedDB available', () => {
  it('readCachedTranscript resolves null when indexedDB is undefined', async () => {
    removeIndexedDb();
    const { readCachedTranscript } = await importFresh();
    await expect(readCachedTranscript('s1')).resolves.toBeNull();
  });

  it('readCachedTranscript resolves null when accessing indexedDB throws', async () => {
    throwingIndexedDbGetter();
    const { readCachedTranscript } = await importFresh();
    await expect(readCachedTranscript('s1')).resolves.toBeNull();
  });

  it('writeCachedTranscript resolves without throwing when indexedDB is undefined', async () => {
    removeIndexedDb();
    const { writeCachedTranscript } = await importFresh();
    await expect(writeCachedTranscript(transcript())).resolves.toBeUndefined();
  });

  it('deleteCachedTranscript resolves without throwing when indexedDB is undefined', async () => {
    removeIndexedDb();
    const { deleteCachedTranscript } = await importFresh();
    await expect(deleteCachedTranscript('s1')).resolves.toBeUndefined();
  });
});

describe('transcriptCache — openDb failure modes', () => {
  it('readCachedTranscript resolves null when indexedDB.open throws synchronously', async () => {
    installFakeIndexedDb({ throwOnOpen: true });
    const { readCachedTranscript } = await importFresh();
    await expect(readCachedTranscript('s1')).resolves.toBeNull();
  });

  it('readCachedTranscript resolves null when the open request errors', async () => {
    installFakeIndexedDb({ errorOnOpen: true });
    const { readCachedTranscript } = await importFresh();
    await expect(readCachedTranscript('s1')).resolves.toBeNull();
  });

  it('readCachedTranscript resolves null when the open request is blocked', async () => {
    installFakeIndexedDb({ blockedOnOpen: true });
    const { readCachedTranscript } = await importFresh();
    await expect(readCachedTranscript('s1')).resolves.toBeNull();
  });

  it('caches the same open across calls (module-level dbPromise reused)', async () => {
    const db = installFakeIndexedDb();
    const openSpy = vi.spyOn(globalThis.indexedDB as unknown as { open: () => unknown }, 'open');
    const { readCachedTranscript, writeCachedTranscript } = await importFresh();
    await readCachedTranscript('s1');
    await writeCachedTranscript(transcript({ sessionId: 's2' }));
    await readCachedTranscript('s3');
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(db.stores.has('transcripts')).toBe(true);
  });
});

describe('transcriptCache — read/write/delete round trip', () => {
  beforeEach(() => {
    installFakeIndexedDb();
  });

  it('reports a cache miss for a session never written', async () => {
    const { readCachedTranscript } = await importFresh();
    await expect(readCachedTranscript('missing')).resolves.toBeNull();
  });

  it('reads back exactly what was written (cache hit)', async () => {
    const { readCachedTranscript, writeCachedTranscript } = await importFresh();
    const entry = transcript({
      sessionId: 'hit-me',
      serverMessages: [{ id: 'm1', sessionId: 'hit-me', timestamp: '2026-09-01T00:00:00.000Z', provider: 'claude', kind: 'text', role: 'user', content: 'hi' } as never],
      total: 1,
      fingerprint: '1:m1:2026-09-01T00:00:00.000Z',
    });
    await writeCachedTranscript(entry);
    const read = await readCachedTranscript('hit-me');
    expect(read).toEqual(entry);
  });

  it('deleteCachedTranscript removes a previously written entry', async () => {
    const { readCachedTranscript, writeCachedTranscript, deleteCachedTranscript } = await importFresh();
    await writeCachedTranscript(transcript({ sessionId: 'to-delete' }));
    await expect(readCachedTranscript('to-delete')).resolves.not.toBeNull();

    await deleteCachedTranscript('to-delete');
    await expect(readCachedTranscript('to-delete')).resolves.toBeNull();
  });

  it('deleteCachedTranscript on an unknown session is a silent no-op', async () => {
    const { deleteCachedTranscript } = await importFresh();
    await expect(deleteCachedTranscript('never-existed')).resolves.toBeUndefined();
  });

  it('overwriting an existing session replaces its record rather than duplicating it', async () => {
    const { readCachedTranscript, writeCachedTranscript } = await importFresh();
    await writeCachedTranscript(transcript({ sessionId: 'dup', total: 1, cachedAt: 1 }));
    await writeCachedTranscript(transcript({ sessionId: 'dup', total: 2, cachedAt: 2 }));
    const read = await readCachedTranscript('dup');
    expect(read?.total).toBe(2);
  });
});

describe('transcriptCache — LRU eviction on write', () => {
  it('does not evict anything while under the cap', async () => {
    installFakeIndexedDb();
    const { readCachedTranscript, writeCachedTranscript } = await importFresh();
    for (let i = 0; i < 5; i += 1) {
      await writeCachedTranscript(transcript({ sessionId: `s${i}`, cachedAt: i }));
    }
    for (let i = 0; i < 5; i += 1) {
      await expect(readCachedTranscript(`s${i}`)).resolves.not.toBeNull();
    }
  });

  it('evicts the oldest sessions once the cap is exceeded, keeping the just-written one', async () => {
    installFakeIndexedDb();
    const { readCachedTranscript, writeCachedTranscript } = await importFresh();

    // MAX_CACHED_SESSIONS is 40. Write 41 distinct sessions with increasing
    // cachedAt so session 0 is the oldest and should be the one evicted.
    for (let i = 0; i < 41; i += 1) {
      await writeCachedTranscript(transcript({ sessionId: `evict-${i}`, cachedAt: i }));
    }

    await expect(readCachedTranscript('evict-0')).resolves.toBeNull();
    await expect(readCachedTranscript('evict-40')).resolves.not.toBeNull();
    await expect(readCachedTranscript('evict-1')).resolves.not.toBeNull();
  });

  it('never evicts the session currently being written even if it is the oldest entry', async () => {
    installFakeIndexedDb();
    const { readCachedTranscript, writeCachedTranscript } = await importFresh();

    // Seed 40 sessions with a later cachedAt than the one written last, so
    // the last write is the oldest by timestamp but must still survive.
    for (let i = 0; i < 40; i += 1) {
      await writeCachedTranscript(transcript({ sessionId: `seed-${i}`, cachedAt: 1000 + i }));
    }
    await writeCachedTranscript(transcript({ sessionId: 'oldest-but-just-written', cachedAt: 0 }));

    await expect(readCachedTranscript('oldest-but-just-written')).resolves.not.toBeNull();
    // Exactly one of the seeds must have been evicted to make room.
    const seedReads = await Promise.all(
      Array.from({ length: 40 }, (_, i) => readCachedTranscript(`seed-${i}`)),
    );
    expect(seedReads.filter((r) => r === null)).toHaveLength(1);
  });
});

describe('transcriptCache — best-effort error handling', () => {
  it('readCachedTranscript resolves null when the store read throws synchronously', async () => {
    installFakeIndexedDb({ failGet: true });
    const { readCachedTranscript } = await importFresh();
    await expect(readCachedTranscript('s1')).resolves.toBeNull();
  });

  it('writeCachedTranscript swallows an aborted write transaction', async () => {
    installFakeIndexedDb({ abortWrites: true });
    const { readCachedTranscript, writeCachedTranscript } = await importFresh();
    await expect(writeCachedTranscript(transcript({ sessionId: 'aborted' }))).resolves.toBeUndefined();
    // The transaction aborted, so the write never lands and no eviction runs.
    await expect(readCachedTranscript('aborted')).resolves.toBeNull();
  });

  it('deleteCachedTranscript resolves without throwing when its transaction aborts', async () => {
    installFakeIndexedDb({ abortWrites: true });
    const { deleteCachedTranscript } = await importFresh();
    await expect(deleteCachedTranscript('whatever')).resolves.toBeUndefined();
  });

  it('writeCachedTranscript resolves even when the eviction scan errors (unknown index)', async () => {
    installFakeIndexedDb({ failIndex: true });
    const { readCachedTranscript, writeCachedTranscript } = await importFresh();
    await expect(writeCachedTranscript(transcript({ sessionId: 'idx-fail' }))).resolves.toBeUndefined();
    // The write itself still succeeds even though the eviction meta-scan failed.
    await expect(readCachedTranscript('idx-fail')).resolves.not.toBeNull();
  });

  it('writeCachedTranscript resolves even when the eviction cursor errors mid-scan', async () => {
    installFakeIndexedDb({ failCursor: true });
    const { readCachedTranscript, writeCachedTranscript } = await importFresh();
    await expect(writeCachedTranscript(transcript({ sessionId: 'cursor-fail' }))).resolves.toBeUndefined();
    await expect(readCachedTranscript('cursor-fail')).resolves.not.toBeNull();
  });

  it('writeCachedTranscript swallows a synchronous throw from db.transaction', async () => {
    installFakeIndexedDb({ throwOnReadwriteTx: true });
    const { writeCachedTranscript } = await importFresh();
    await expect(writeCachedTranscript(transcript({ sessionId: 'tx-throws' }))).resolves.toBeUndefined();
  });

  it('deleteCachedTranscript swallows a synchronous throw from db.transaction', async () => {
    installFakeIndexedDb({ throwOnReadwriteTx: true });
    const { deleteCachedTranscript } = await importFresh();
    await expect(deleteCachedTranscript('tx-throws')).resolves.toBeUndefined();
  });
});
