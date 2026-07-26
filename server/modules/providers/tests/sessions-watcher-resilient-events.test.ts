import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  buildResilientSessionEvents,
  buildSessionUpsertedEvent,
} from '@/modules/providers/services/sessions-watcher.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-watcher-events-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

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

test('disk-watcher upserts classify a newly discovered terminal session as cli-origin', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('native-cli-session', 'claude', '/workspace/cli-origin');

    const serialized = await buildSessionUpsertedEvent('native-cli-session');
    assert.ok(serialized, 'indexed session should produce an upsert');

    const event = JSON.parse(serialized) as {
      session: { id: string; origin?: string };
    };
    assert.equal(event.session.id, 'native-cli-session');
    assert.equal(event.session.origin, 'cli');
  });
});
