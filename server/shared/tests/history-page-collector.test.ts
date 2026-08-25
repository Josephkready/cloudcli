import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareHistoryTimestamps,
  HistoryPageCollector,
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
