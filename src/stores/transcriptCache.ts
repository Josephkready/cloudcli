/**
 * On-device transcript cache (#511): an IndexedDB store of per-session loaded
 * transcripts, so re-opening a conversation paints from disk instead of the
 * network and scrolling back through a long thread stops being re-paid on every
 * open/reload.
 *
 * Every entry point is best-effort: IndexedDB can be absent (SSR, a locked-down
 * embedding), disabled (Safari private browsing historically throws on open),
 * or over quota. None of that may break chat — the network path is always the
 * source of truth — so every operation catches and degrades to a no-op / null.
 * The decisions (what to cache, what to evict) live in `transcriptCache.pure.ts`.
 */

import {
  MAX_CACHED_SESSIONS,
  selectEvictions,
  type CachedTranscript,
  type CachedTranscriptMeta,
} from './transcriptCache.pure';

const DB_NAME = 'cloudcli-transcripts';
const DB_VERSION = 1;
const STORE = 'transcripts';
const CACHED_AT_INDEX = 'cachedAt';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    // Accessing `indexedDB` itself can throw in some sandboxed contexts.
    return false;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (!hasIndexedDb()) {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const done = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'sessionId' });
          store.createIndex(CACHED_AT_INDEX, 'cachedAt', { unique: false });
        }
      };
      request.onsuccess = () => done(request.result);
      request.onerror = () => done(null);
      request.onblocked = () => done(null);
    } catch {
      done(null);
    }
  }).catch(() => null);

  return dbPromise;
}

/** Resolves a transaction's request to its result, or null on any failure. */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/**
 * The cached transcript for a session, or null if none / unavailable. Callers
 * hydrate the store from this, then reconcile against the server — so a slightly
 * stale hit is fine and a miss just means the normal network load.
 */
export async function readCachedTranscript(sessionId: string): Promise<CachedTranscript | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const record = await requestToPromise(tx.objectStore(STORE).get(sessionId));
    return (record as CachedTranscript | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Reads only (sessionId, cachedAt) for every entry, for eviction — never the transcripts themselves. */
function readAllMeta(db: IDBDatabase): Promise<CachedTranscriptMeta[]> {
  return new Promise((resolve) => {
    const metas: CachedTranscriptMeta[] = [];
    try {
      const tx = db.transaction(STORE, 'readonly');
      const index = tx.objectStore(STORE).index(CACHED_AT_INDEX);
      const cursorReq = index.openKeyCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve(metas);
          return;
        }
        metas.push({ sessionId: String(cursor.primaryKey), cachedAt: Number(cursor.key) });
        cursor.continue();
      };
      cursorReq.onerror = () => resolve(metas);
    } catch {
      resolve(metas);
    }
  });
}

/**
 * Persists a session's loaded transcript and enforces the LRU cap. Caller has
 * already decided the transcript is worth caching (see `shouldCacheTranscript`).
 * Fire-and-forget: the returned promise never rejects.
 */
export async function writeCachedTranscript(entry: CachedTranscript): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
      tx.objectStore(STORE).put(entry);
    });

    // Enforce the cap after the write, so the just-written session is present
    // in the meta scan and `selectEvictions` can protect it explicitly.
    const metas = await readAllMeta(db);
    const toEvict = selectEvictions(metas, entry.sessionId, MAX_CACHED_SESSIONS);
    if (toEvict.length > 0) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
        const store = tx.objectStore(STORE);
        for (const sessionId of toEvict) store.delete(sessionId);
      });
    }
  } catch {
    // best-effort
  }
}

/** Drops a session's cached transcript (e.g. when it was deleted). */
export async function deleteCachedTranscript(sessionId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
      tx.objectStore(STORE).delete(sessionId);
    });
  } catch {
    // best-effort
  }
}

/** Test-only: reset the memoized DB handle so a fresh fake-indexeddb is picked up. */
export function __resetTranscriptCacheForTests(): void {
  dbPromise = null;
}
