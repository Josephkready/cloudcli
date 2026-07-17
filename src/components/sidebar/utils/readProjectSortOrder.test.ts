import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { readProjectSortOrder } from './utils';

// The `tsx --test` runner has no DOM/localStorage; stub the single method
// `readProjectSortOrder` reads so the default + normalization logic (a
// backward-compat-sensitive change: the default flipped from 'name' to 'count')
// can be exercised without a browser.
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

test('defaults to count when nothing is stored', () => {
  assert.equal(readProjectSortOrder(), 'count');
});

test('defaults to count when settings exist without a sort order', () => {
  store['claude-settings'] = JSON.stringify({ skipPermissions: true });
  assert.equal(readProjectSortOrder(), 'count');
});

test('preserves an explicitly saved order (backward compatibility)', () => {
  for (const order of ['name', 'date', 'count'] as const) {
    store['claude-settings'] = JSON.stringify({ projectSortOrder: order });
    assert.equal(readProjectSortOrder(), order);
  }
});

test('normalizes an unknown stored value back to the count default', () => {
  store['claude-settings'] = JSON.stringify({ projectSortOrder: 'bogus' });
  assert.equal(readProjectSortOrder(), 'count');
});

test('falls back to count on corrupt settings JSON', () => {
  store['claude-settings'] = '{not valid json';
  assert.equal(readProjectSortOrder(), 'count');
});
