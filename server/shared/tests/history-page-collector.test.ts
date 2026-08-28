import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareHistoryTimestamps,
  HistoryPageCollector,
  historyTimestampSortValue,
} from '@/shared/utils.js';

test('retains only limit + offset items while counting the full stream', () => {
  const collector = new HistoryPageCollector<string>({ limit: 20, offset: 40 });

  for (let index = 0; index < 10_000; index += 1) {
    collector.add(`message-${index}`);
  }

  assert.equal(collector.totalItems, 10_000);
  assert.equal(collector.retainedItems, 60);
  assert.deepEqual(collector.page(), {
    items: Array.from({ length: 20 }, (_, index) => `message-${9_940 + index}`),
    hasMore: true,
  });
});

test('offset zero returns the newest items in chronological order', () => {
  const collector = new HistoryPageCollector<string>({ limit: 2, offset: 0 });
  for (const item of ['a', 'b', 'c', 'd', 'e']) collector.add(item);

  assert.deepEqual(collector.page(), { items: ['d', 'e'], hasMore: true });
});

test('offsets walk backward and the oldest page clears hasMore', () => {
  const middle = new HistoryPageCollector<string>({ limit: 2, offset: 2 });
  const oldest = new HistoryPageCollector<string>({ limit: 2, offset: 4 });
  for (const item of ['a', 'b', 'c', 'd', 'e']) {
    middle.add(item);
    oldest.add(item);
  }

  assert.deepEqual(middle.page(), { items: ['b', 'c'], hasMore: true });
  assert.deepEqual(oldest.page(), { items: ['a'], hasMore: false });
});

test('a comparator retains the chronologically newest items from out-of-order input', () => {
  const collector = new HistoryPageCollector<{ id: string; timestamp: number }>({
    limit: 3,
    offset: 0,
    compare: (left, right) => left.timestamp - right.timestamp,
  });

  for (const item of [
    { id: 'fifth', timestamp: 5 },
    { id: 'first', timestamp: 1 },
    { id: 'fourth-a', timestamp: 4 },
    { id: 'second', timestamp: 2 },
    { id: 'fourth-b', timestamp: 4 },
    { id: 'third', timestamp: 3 },
  ]) {
    collector.add(item);
  }

  assert.deepEqual(
    collector.page().items.map((item) => item.id),
    ['fourth-a', 'fourth-b', 'fifth'],
    'equal timestamps preserve input order',
  );
  assert.equal(collector.retainedItems, 3);
});

test('invalid timestamps sort before valid history without evicting newer dated items', () => {
  const collector = new HistoryPageCollector<{ id: string; timestamp: string }>({
    limit: 2,
    offset: 0,
    compare: (left, right) => compareHistoryTimestamps(left.timestamp, right.timestamp),
  });
  for (const item of [
    { id: 'newest', timestamp: '2026-01-03T00:00:00Z' },
    { id: 'invalid', timestamp: 'not-a-date' },
    { id: 'oldest-valid', timestamp: '2026-01-01T00:00:00Z' },
  ]) {
    collector.add(item);
  }

  assert.deepEqual(collector.page().items.map((item) => item.id), ['oldest-valid', 'newest']);
});

test('null limit deliberately retains and returns the full stream before offset', () => {
  const collector = new HistoryPageCollector<string>({ limit: null, offset: 2 });
  for (const item of ['a', 'b', 'c', 'd', 'e']) collector.add(item);

  assert.equal(collector.retainedItems, 5);
  assert.deepEqual(collector.page(), { items: ['a', 'b', 'c'], hasMore: false });
});

test('zero limit retains only the offset context and returns an empty page', () => {
  const collector = new HistoryPageCollector<string>({ limit: 0, offset: 2 });
  for (const item of ['a', 'b', 'c', 'd', 'e']) collector.add(item);

  assert.equal(collector.retainedItems, 2);
  assert.deepEqual(collector.page(), { items: [], hasMore: true });
});

test('offsets beyond the beginning return an empty page', () => {
  const collector = new HistoryPageCollector<string>({ limit: 3, offset: 10 });
  for (const item of ['a', 'b', 'c']) collector.add(item);

  assert.deepEqual(collector.page(), { items: [], hasMore: false });
});

test('invalid direct-call bounds cannot accidentally make retention unbounded', () => {
  const collector = new HistoryPageCollector<string>({ limit: Number.NaN, offset: Infinity });
  for (const item of ['a', 'b', 'c']) collector.add(item);

  assert.equal(collector.retainedItems, 0);
  assert.deepEqual(collector.page(), { items: [], hasMore: true });
});

/**
 * `sortKey` exists to stop the collector re-deriving an ordering value on every
 * comparison — it must therefore order *identically* to the comparator it
 * replaces, including for the awkward cases (equal timestamps, malformed ones).
 * These pin that equivalence, since a divergence would silently reorder
 * transcripts rather than fail anything.
 */
test('sortKey orders a bounded page exactly as the equivalent comparator does', () => {
  const rows = [
    { id: 'newest', timestamp: '2026-01-03T00:00:00Z' },
    { id: 'oldest', timestamp: '2026-01-01T00:00:00Z' },
    { id: 'middle-a', timestamp: '2026-01-02T00:00:00Z' },
    { id: 'middle-b', timestamp: '2026-01-02T00:00:00Z' },
  ];

  const viaCompare = new HistoryPageCollector<typeof rows[number]>({
    limit: 3,
    offset: 0,
    compare: (left, right) => compareHistoryTimestamps(left.timestamp, right.timestamp),
  });
  const viaSortKey = new HistoryPageCollector<typeof rows[number]>({
    limit: 3,
    offset: 0,
    sortKey: (row) => historyTimestampSortValue(row.timestamp),
  });
  for (const row of rows) {
    viaCompare.add(row);
    viaSortKey.add(row);
  }

  assert.deepEqual(
    viaSortKey.page().items.map((item) => item.id),
    viaCompare.page().items.map((item) => item.id),
  );
  // `page()` returns the newest `limit` items, so `oldest` is the one evicted —
  // and the two equal timestamps keep their input order behind it.
  assert.deepEqual(viaSortKey.page().items.map((item) => item.id), ['middle-a', 'middle-b', 'newest']);
});

test('sortKey keeps malformed timestamps ahead of dated history, in stream order', () => {
  const collector = new HistoryPageCollector<{ id: string; timestamp: string }>({
    limit: 4,
    offset: 0,
    sortKey: (row) => historyTimestampSortValue(row.timestamp),
  });
  for (const row of [
    { id: 'newest', timestamp: '2026-01-03T00:00:00Z' },
    { id: 'invalid-first', timestamp: 'not-a-date' },
    { id: 'oldest-valid', timestamp: '2026-01-01T00:00:00Z' },
    { id: 'invalid-second', timestamp: 'also-not-a-date' },
  ]) {
    collector.add(row);
  }

  // Two malformed rows both key to -Infinity, so they must not be reordered
  // against each other — that is the case a naive `key - key` (NaN) would break.
  assert.deepEqual(
    collector.page().items.map((item) => item.id),
    ['invalid-first', 'invalid-second', 'oldest-valid', 'newest'],
  );
});

test('sortKey orders an unbounded request too, sorting once at the end', () => {
  const collector = new HistoryPageCollector<{ id: string; timestamp: string }>({
    limit: null,
    offset: 0,
    sortKey: (row) => historyTimestampSortValue(row.timestamp),
  });
  for (const row of [
    { id: 'c', timestamp: '2026-01-03T00:00:00Z' },
    { id: 'a', timestamp: '2026-01-01T00:00:00Z' },
    { id: 'b', timestamp: '2026-01-02T00:00:00Z' },
  ]) {
    collector.add(row);
  }

  assert.deepEqual(collector.page().items.map((item) => item.id), ['a', 'b', 'c']);
});

test('historyTimestampSortValue matches compareHistoryTimestamps on the values it keys', () => {
  const values = ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'not-a-date', 0, null];
  for (const left of values) {
    for (const right of values) {
      const viaCompare = Math.sign(compareHistoryTimestamps(left, right));
      const leftKey = historyTimestampSortValue(left);
      const rightKey = historyTimestampSortValue(right);
      const viaKey = leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      assert.equal(viaKey, viaCompare, `disagreed on ${String(left)} vs ${String(right)}`);
    }
  }
});
