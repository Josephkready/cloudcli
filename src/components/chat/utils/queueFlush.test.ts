import assert from 'node:assert/strict';
import test from 'node:test';

import { decideQueueFlush, IDLE_FLUSH_HOLD_MS } from './queueFlush';

const base = {
  sessionChanged: false,
  isLoading: false,
  isFlushing: false,
  queueLength: 1,
  wasLoading: false,
};

test('completion edge (run just ended) flushes immediately', () => {
  assert.deepEqual(decideQueueFlush({ ...base, wasLoading: true }), { flush: true, delayMs: 0 });
});

test('restored/idle queue flushes after the idle hold', () => {
  assert.deepEqual(decideQueueFlush({ ...base, wasLoading: false }), {
    flush: true,
    delayMs: IDLE_FLUSH_HOLD_MS,
  });
});

test('does not flush while a run is in flight', () => {
  assert.equal(decideQueueFlush({ ...base, isLoading: true, wasLoading: true }).flush, false);
});

test('does not flush while another flush is already in flight (serialization guard)', () => {
  // Even on a completion edge with items queued, an in-flight flush must block a
  // second dispatch — this is what prevents two queued messages overlapping.
  assert.equal(decideQueueFlush({ ...base, isFlushing: true, wasLoading: true }).flush, false);
});

test('does not flush across a session switch', () => {
  assert.equal(decideQueueFlush({ ...base, sessionChanged: true, wasLoading: true }).flush, false);
});

test('does not flush when the queue is empty', () => {
  assert.equal(decideQueueFlush({ ...base, queueLength: 0, wasLoading: true }).flush, false);
});
