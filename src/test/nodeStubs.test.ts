import assert from 'node:assert/strict';
import test from 'node:test';

import { withGlobals, createLocalStorage, withLocalStorage, makeTranslator } from './nodeStubs';

// Guard test for the shared node:test stub helpers (mirrors setup.spec.ts for
// the vitest side). If these regress, every consumer's isolation breaks.

test('withGlobals installs a value and restores a previously-absent key', () => {
  const key = '__nodeStubsProbe__';
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, key), false);
  const inside = withGlobals({ [key]: 42 }, () => (globalThis as Record<string, unknown>)[key]);
  assert.equal(inside, 42);
  // The key was absent before, so it must be deleted (not left as undefined).
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, key), false);
});

test('withGlobals restores a pre-existing key to its exact prior value', () => {
  const g = globalThis as Record<string, unknown>;
  const key = '__nodeStubsExisting__';
  g[key] = 'original';
  try {
    withGlobals({ [key]: 'temp' }, () => {
      assert.equal(g[key], 'temp');
    });
    assert.equal(g[key], 'original');
  } finally {
    delete g[key];
  }
});

test('withGlobals restores even when the callback throws', () => {
  const key = '__nodeStubsThrow__';
  assert.throws(() => {
    withGlobals({ [key]: 1 }, () => {
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, key), false);
});

test('createLocalStorage stores entries as own-enumerable keys, methods hidden', () => {
  const store = createLocalStorage({ a: '1' });
  store.setItem('b', '2');
  assert.equal(store.getItem('a'), '1');
  assert.equal(store.getItem('b'), '2');
  assert.equal(store.getItem('missing'), null);
  // Object.keys must see only stored entries, not the API methods — this is
  // what safeLocalStorage's quota-cleanup relies on.
  assert.deepEqual(Object.keys(store).sort(), ['a', 'b']);
  store.removeItem('a');
  assert.equal(store.getItem('a'), null);
  store.clear();
  assert.deepEqual(Object.keys(store), []);
});

test('withLocalStorage exposes the store and restores the global afterward', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const result = withLocalStorage({ seeded: 'yes' }, (store) => {
    assert.equal(store.getItem('seeded'), 'yes');
    assert.equal((globalThis as { localStorage: Storage }).localStorage.getItem('seeded'), 'yes');
    return 'ok';
  });
  assert.equal(result, 'ok');
  // In this runner localStorage is not a global, so it must be removed again.
  if (!had) {
    assert.equal(Object.prototype.hasOwnProperty.call(globalThis, 'localStorage'), false);
  }
});

test('makeTranslator echoes keys, appends counts, and records calls', () => {
  const t = makeTranslator();
  assert.equal(t('projects.newSession'), 'projects.newSession');
  assert.equal(t('time.minutesAgo', { count: 5 }), 'time.minutesAgo#5');
  assert.deepEqual(t.calls, [
    { key: 'projects.newSession', count: undefined },
    { key: 'time.minutesAgo', count: 5 },
  ]);
});
