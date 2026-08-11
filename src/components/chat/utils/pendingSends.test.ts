import assert from 'node:assert/strict';
import test from 'node:test';

import { withLocalStorage } from '../../../test/nodeStubs';

import {
  appendPendingSend,
  makePendingSendId,
  markPendingSendDispatched,
  parsePendingSends,
  partitionPendingSends,
  pendingSendKey,
  readPendingSends,
  removePendingSend,
  serializePendingSends,
  writePendingSends,
  type PendingSend,
} from './pendingSends';

const entry = (over: Partial<PendingSend> = {}): PendingSend => ({
  id: 'pending_1',
  content: 'hello',
  timestamp: '2026-08-11T14:42:02.000Z',
  ...over,
});

/* ── parse ───────────────────────────────────────────────────────────────── */

test('parse: null / empty / non-array input yields nothing', () => {
  assert.deepEqual(parsePendingSends(null), []);
  assert.deepEqual(parsePendingSends(''), []);
  assert.deepEqual(parsePendingSends('not json'), []);
  // Unlike the queued-message store, a bare string is NOT legacy draft text
  // here — this key has only ever held JSON, so it is dropped rather than
  // resurrected as a message the user never wrote.
  assert.deepEqual(parsePendingSends('"just a string"'), []);
  assert.deepEqual(parsePendingSends(JSON.stringify({ id: 'a', content: 'b' })), []);
});

test('parse: reads the array format, preserving order and options', () => {
  const raw = JSON.stringify([
    entry({ id: 'a', content: 'first', options: { model: 'x' } }),
    entry({ id: 'b', content: 'second' }),
  ]);
  const parsed = parsePendingSends(raw);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((e) => e.id), ['a', 'b']);
  assert.deepEqual(parsed[0]?.options, { model: 'x' });
  assert.equal(parsed[1]?.options, undefined);
});

test('parse: drops entries missing an id or content', () => {
  const raw = JSON.stringify([
    { content: 'no id', timestamp: '2026-08-11T14:42:02.000Z' },
    { id: '', content: 'empty id', timestamp: '2026-08-11T14:42:02.000Z' },
    { id: 'c', content: '   ', timestamp: '2026-08-11T14:42:02.000Z' },
    entry({ id: 'keep' }),
  ]);
  assert.deepEqual(parsePendingSends(raw).map((e) => e.id), ['keep']);
});

// An unparseable timestamp can never match a server echo, so keeping it would
// mean resending that message on every single reconnect, forever.
test('parse: drops entries whose timestamp could never match an echo', () => {
  const raw = JSON.stringify([
    { id: 'a', content: 'x', timestamp: 'not-a-date' },
    { id: 'b', content: 'x' },
    entry({ id: 'keep' }),
  ]);
  assert.deepEqual(parsePendingSends(raw).map((e) => e.id), ['keep']);
});

/* ── serialize ───────────────────────────────────────────────────────────── */

test('serialize: returns null when nothing is worth persisting', () => {
  assert.equal(serializePendingSends([]), null);
  assert.equal(serializePendingSends([{ id: '', content: '', timestamp: '' } as PendingSend]), null);
});

test('serialize / parse round-trips an entry unchanged', () => {
  const original = [entry({ options: { model: 'sonnet', images: [] } })];
  assert.deepEqual(parsePendingSends(serializePendingSends(original)), original);
});

/* ── storage round-trip ──────────────────────────────────────────────────── */

test('write then read round-trips through localStorage', () => {
  withLocalStorage({}, (store) => {
    writePendingSends('s1', [entry({ id: 'a' }), entry({ id: 'b' })]);
    assert.ok(store.getItem(pendingSendKey('s1')));
    assert.deepEqual(readPendingSends('s1').map((e) => e.id), ['a', 'b']);
  });
});

test('writing an empty list removes the key rather than storing "[]"', () => {
  withLocalStorage({}, (store) => {
    writePendingSends('s1', [entry()]);
    writePendingSends('s1', []);
    assert.equal(store.getItem(pendingSendKey('s1')), null);
  });
});

test('append records an outgoing message without disturbing earlier ones', () => {
  withLocalStorage({}, () => {
    appendPendingSend('s1', entry({ id: 'a', content: 'first' }));
    appendPendingSend('s1', entry({ id: 'b', content: 'second' }));
    assert.deepEqual(readPendingSends('s1').map((e) => e.content), ['first', 'second']);
  });
});

test('append keeps sessions independent', () => {
  withLocalStorage({}, () => {
    appendPendingSend('s1', entry({ id: 'a' }));
    appendPendingSend('s2', entry({ id: 'b' }));
    assert.deepEqual(readPendingSends('s1').map((e) => e.id), ['a']);
    assert.deepEqual(readPendingSends('s2').map((e) => e.id), ['b']);
  });
});

test('remove drops only the confirmed entry', () => {
  withLocalStorage({}, () => {
    appendPendingSend('s1', entry({ id: 'a' }));
    appendPendingSend('s1', entry({ id: 'b' }));
    removePendingSend('s1', 'a');
    assert.deepEqual(readPendingSends('s1').map((e) => e.id), ['b']);
    // Removing the last entry clears the key entirely.
    removePendingSend('s1', 'b');
    assert.deepEqual(readPendingSends('s1'), []);
  });
});

test('removing an id that is not present is a no-op', () => {
  withLocalStorage({}, () => {
    appendPendingSend('s1', entry({ id: 'a' }));
    removePendingSend('s1', 'nope');
    assert.deepEqual(readPendingSends('s1').map((e) => e.id), ['a']);
  });
});

/* ── the dispatched flag: "never sent" vs "might be in flight" ───────────── */

test('dispatched: false survives a storage round-trip', () => {
  withLocalStorage({}, () => {
    appendPendingSend('s1', entry({ id: 'a', dispatched: false }));
    assert.equal(readPendingSends('s1')[0]?.dispatched, false);
  });
});

// Absent must read as "might be in flight" — the conservative case that waits
// before resending — so it is deliberately not persisted as an explicit true.
test('an entry with no dispatched flag round-trips as absent, not false', () => {
  withLocalStorage({}, () => {
    appendPendingSend('s1', entry({ id: 'a' }));
    assert.equal(readPendingSends('s1')[0]?.dispatched, undefined);
  });
});

// Promotion is the absence of the flag, not an explicit `true`: only `false`
// is persisted, and anything else already reads as "might be in flight". What
// matters is that 'a' stops being the known-never-delivered case and 'b' does
// not.
test('markPendingSendDispatched promotes only the named entry', () => {
  withLocalStorage({}, () => {
    appendPendingSend('s1', entry({ id: 'a', dispatched: false }));
    appendPendingSend('s1', entry({ id: 'b', dispatched: false }));
    markPendingSendDispatched('s1', 'a');
    const stored = readPendingSends('s1');
    assert.notEqual(stored.find((e) => e.id === 'a')?.dispatched, false);
    assert.equal(stored.find((e) => e.id === 'b')?.dispatched, false);
  });
});

test('markPendingSendDispatched on an unknown id changes nothing', () => {
  withLocalStorage({}, () => {
    appendPendingSend('s1', entry({ id: 'a', dispatched: false }));
    markPendingSendDispatched('s1', 'nope');
    assert.equal(readPendingSends('s1')[0]?.dispatched, false);
  });
});

test('makePendingSendId returns distinct ids', () => {
  const ids = new Set([makePendingSendId(), makePendingSendId(), makePendingSendId()]);
  assert.equal(ids.size, 3);
});

/* ── partition: the confirm-vs-resend decision ───────────────────────────── */

test('partition splits echoed entries from ones the server never got', () => {
  const entries = [entry({ id: 'a', content: 'landed' }), entry({ id: 'b', content: 'lost' })];
  const { confirmed, unconfirmed } = partitionPendingSends(
    entries,
    (e) => e.content === 'landed',
  );
  assert.deepEqual(confirmed.map((e) => e.id), ['a']);
  assert.deepEqual(unconfirmed.map((e) => e.id), ['b']);
});

test('partition treats an empty list as nothing to do', () => {
  const { confirmed, unconfirmed } = partitionPendingSends([], () => true);
  assert.deepEqual(confirmed, []);
  assert.deepEqual(unconfirmed, []);
});

// The half-open-socket case: `send()` reported success, so nothing at send time
// flagged a problem, yet the server transcript has no echo. That entry must come
// back as unconfirmed or the message is lost exactly as reported in #325.
test('partition marks an entry unconfirmed when no echo exists, however it was sent', () => {
  const { unconfirmed } = partitionPendingSends([entry({ id: 'a' })], () => false);
  assert.deepEqual(unconfirmed.map((e) => e.id), ['a']);
});

test('partition preserves order within each group', () => {
  const entries = [
    entry({ id: 'a', content: 'no' }),
    entry({ id: 'b', content: 'yes' }),
    entry({ id: 'c', content: 'no' }),
    entry({ id: 'd', content: 'yes' }),
  ];
  const { confirmed, unconfirmed } = partitionPendingSends(entries, (e) => e.content === 'yes');
  assert.deepEqual(confirmed.map((e) => e.id), ['b', 'd']);
  assert.deepEqual(unconfirmed.map((e) => e.id), ['a', 'c']);
});
