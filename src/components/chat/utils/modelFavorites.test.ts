import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { readFavoriteModelIds, writeFavoriteModelIds, sortModelsByFavorite } from './modelFavorites';

// The `tsx --test` runner has no DOM; stub localStorage so the persistence
// helpers (which go through safeLocalStorage) can be exercised.
let store: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => (key in store ? store[key] : null),
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    store = {};
  },
} as unknown as Storage;

beforeEach(() => {
  store = {};
  (globalThis as { localStorage?: Storage }).localStorage = localStorageStub;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

test('reads an empty list when nothing is stored', () => {
  assert.deepEqual(readFavoriteModelIds('claude'), []);
});

test('round-trips favorites through write/read', () => {
  writeFavoriteModelIds('claude', ['a', 'b']);
  assert.deepEqual(readFavoriteModelIds('claude'), ['a', 'b']);
});

test('scopes favorites per provider', () => {
  writeFavoriteModelIds('claude', ['claude-x']);
  writeFavoriteModelIds('codex', ['codex-y']);
  assert.deepEqual(readFavoriteModelIds('claude'), ['claude-x']);
  assert.deepEqual(readFavoriteModelIds('codex'), ['codex-y']);
});

test('ignores malformed stored values', () => {
  store['claude-favorite-models'] = '{not json';
  assert.deepEqual(readFavoriteModelIds('claude'), []);
  store['claude-favorite-models'] = JSON.stringify({ not: 'an array' });
  assert.deepEqual(readFavoriteModelIds('claude'), []);
  store['claude-favorite-models'] = JSON.stringify(['ok', 3, '', null]);
  assert.deepEqual(readFavoriteModelIds('claude'), ['ok']);
});

test('sorts favorites first while preserving catalog order within each group', () => {
  const options = [
    { value: 'm1' },
    { value: 'm2' },
    { value: 'm3' },
    { value: 'm4' },
  ];
  const sorted = sortModelsByFavorite(options, new Set(['m3', 'm1']));
  // Favorites keep catalog order (m1 before m3), then the rest in catalog order.
  assert.deepEqual(sorted.map((o) => o.value), ['m1', 'm3', 'm2', 'm4']);
});

test('returns the input unchanged when there are no favorites', () => {
  const options = [{ value: 'm1' }, { value: 'm2' }];
  const sorted = sortModelsByFavorite(options, new Set());
  assert.equal(sorted, options);
});
