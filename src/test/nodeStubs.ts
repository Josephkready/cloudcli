// Shared browser-global stubs for node:test (`tsx --test`) unit tests.
//
// The front-end unit runner has no DOM, so pure utilities that read
// `localStorage`, `window`, or a `WebSocket` global need a stub installed for
// the duration of a test and then removed so tests stay isolated. Prefer these
// helpers over hand-rolling the same boilerplate per file. This module lives
// under `src/test/` (like the vitest `setup.ts`) but is deliberately NOT a
// `*.test.ts`/`*.spec.ts` file, so neither runner picks it up as a suite.

import type { TFunction } from 'i18next';

type GlobalRecord = Record<string, unknown>;

/**
 * Temporarily install `values` onto `globalThis`, run `fn`, then restore the
 * previous state exactly — re-assigning keys that existed and deleting keys
 * that did not. Restoration runs even if `fn` throws.
 */
export function withGlobals<T>(values: GlobalRecord, fn: () => T): T {
  const g = globalThis as GlobalRecord;
  const saved = Object.keys(values).map((key) => ({
    key,
    had: Object.prototype.hasOwnProperty.call(g, key),
    prev: g[key],
  }));
  for (const key of Object.keys(values)) {
    g[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const { key, had, prev } of saved) {
      if (had) g[key] = prev;
      else Reflect.deleteProperty(g, key);
    }
  }
}

export interface MemoryLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

/**
 * A minimal in-memory `localStorage`. Stored entries are the object's own
 * enumerable string properties (as in a real `Storage`), so code that iterates
 * `Object.keys(localStorage)` — e.g. the quota-cleanup path in
 * `safeLocalStorage` — sees only the stored keys. The API methods are
 * non-enumerable so they never leak into that iteration.
 */
export function createLocalStorage(seed: Record<string, string> = {}): MemoryLocalStorage {
  const storage: GlobalRecord = {};
  const define = (name: string, value: unknown) =>
    Object.defineProperty(storage, name, { value, enumerable: false, writable: true });

  define('getItem', (key: string): string | null =>
    Object.prototype.hasOwnProperty.call(storage, key) ? (storage[key] as string) : null,
  );
  define('setItem', (key: string, value: string): void => {
    storage[key] = String(value);
  });
  define('removeItem', (key: string): void => {
    delete storage[key];
  });
  define('clear', (): void => {
    for (const key of Object.keys(storage)) delete storage[key];
  });

  for (const [key, value] of Object.entries(seed)) {
    storage[key] = String(value);
  }
  return storage as unknown as MemoryLocalStorage;
}

/**
 * Run `fn` with an in-memory `localStorage` seeded from `seed`, restoring the
 * previous global afterwards. `fn` receives the store for direct assertions.
 */
export function withLocalStorage<T>(
  seed: Record<string, string>,
  fn: (store: MemoryLocalStorage) => T,
): T {
  const store = createLocalStorage(seed);
  return withGlobals({ localStorage: store }, () => fn(store));
}

/**
 * A recording `t()` translator for i18n-facing utilities. It echoes the key
 * (appending `#<count>` when an interpolation count is supplied) so a test can
 * assert on the key and count without loading i18next. Every call is recorded
 * on `.calls`.
 */
export function makeTranslator(): TFunction & { calls: Array<{ key: string; count?: number }> } {
  const calls: Array<{ key: string; count?: number }> = [];
  const fn = (key: string, opts?: { count?: number }): string => {
    calls.push({ key, count: opts?.count });
    return opts?.count != null ? `${key}#${opts.count}` : key;
  };
  return Object.assign(fn as unknown as TFunction, { calls });
}
