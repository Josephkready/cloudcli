import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResilientSessionEvents } from '@/modules/providers/services/sessions-watcher.service.js';

// Regression tests for the per-session isolation fix (#104). One session's
// event build throwing must never drop the rest of a batch: by the time
// broadcastWatcherBatch runs, the batch has already been detached from the
// debouncer queue, so an aborted loop would silently and permanently lose every
// other session's delta.

test('a throwing session does not drop the other sessions in the batch', async () => {
  const errors: Array<{ sessionId: string; message: string }> = [];

  const events = await buildResilientSessionEvents(
    ['session-a', 'session-boom', 'session-c'],
    async (sessionId) => {
      if (sessionId === 'session-boom') {
        throw new Error('live-status probe blew up');
      }
      return `event:${sessionId}`;
    },
    (sessionId, error) => {
      errors.push({ sessionId, message: error instanceof Error ? error.message : String(error) });
    }
  );

  // The healthy sessions' deltas survive the failing one.
  assert.deepEqual(events, ['event:session-a', 'event:session-c']);
  assert.deepEqual(errors, [{ sessionId: 'session-boom', message: 'live-status probe blew up' }]);
});

test('sessions that resolve to null (unindexed/archived) are skipped, not broadcast', async () => {
  const events = await buildResilientSessionEvents(
    ['session-a', 'session-missing', 'session-c'],
    async (sessionId) => (sessionId === 'session-missing' ? null : `event:${sessionId}`)
  );

  assert.deepEqual(events, ['event:session-a', 'event:session-c']);
});

test('every session failing yields an empty event list rather than throwing', async () => {
  const errors: string[] = [];

  const events = await buildResilientSessionEvents(
    ['a', 'b'],
    async () => {
      throw new Error('always fails');
    },
    (sessionId) => errors.push(sessionId)
  );

  assert.deepEqual(events, []);
  assert.deepEqual(errors, ['a', 'b']);
});

test('all-successful builds are returned in id order', async () => {
  const events = await buildResilientSessionEvents(
    new Set(['s1', 's2', 's3']),
    async (sessionId) => `event:${sessionId}`
  );

  assert.deepEqual(events, ['event:s1', 'event:s2', 'event:s3']);
});

test('an empty batch produces no events and does not invoke the builder', async () => {
  let calls = 0;

  const events = await buildResilientSessionEvents([], async () => {
    calls += 1;
    return 'event';
  });

  assert.deepEqual(events, []);
  assert.equal(calls, 0);
});
