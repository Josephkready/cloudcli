import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import { computeArchiveCutoff, sessionsService } from './sessions.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-service-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

// A newly-created app session has no provider_session_id, so fetchHistory stamps
// last_viewed_at (when at offset 0) and then short-circuits before touching any
// provider runtime — which lets us test the "viewed" gating in isolation.

test('fetchHistory stamps last_viewed_at on a fresh open (offset 0)', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('view-open', 'claude', '/workspace/demo');
    assert.equal(sessionsDb.getSessionById('view-open')?.last_viewed_at, null);

    await sessionsService.fetchHistory('view-open', { offset: 0 });

    assert.ok(
      sessionsDb.getSessionById('view-open')?.last_viewed_at,
      'opening a session (offset 0) should stamp last_viewed_at',
    );
  });
});

test('fetchHistory does NOT stamp last_viewed_at when paginating (offset > 0)', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('view-page', 'claude', '/workspace/demo');

    await sessionsService.fetchHistory('view-page', { offset: 20 });

    assert.equal(
      sessionsDb.getSessionById('view-page')?.last_viewed_at,
      null,
      'paging older messages must not clear Done by stamping viewed',
    );
  });
});

test('fetchHistory treats a missing offset as a fresh open', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('view-default', 'claude', '/workspace/demo');

    await sessionsService.fetchHistory('view-default');

    assert.ok(
      sessionsDb.getSessionById('view-default')?.last_viewed_at,
      'a fetch with no offset defaults to 0 and stamps viewed',
    );
  });
});

test('computeArchiveCutoff subtracts whole days from the reference instant', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');

  assert.equal(computeArchiveCutoff(now, 7), '2026-07-11T12:00:00.000Z');
  assert.equal(computeArchiveCutoff(now, 30), '2026-06-18T12:00:00.000Z');
  assert.equal(computeArchiveCutoff(now, 90), '2026-04-19T12:00:00.000Z');
});

test('computeArchiveCutoff keeps the time-of-day across a month boundary', () => {
  const now = new Date('2026-03-05T08:30:00.000Z');

  assert.equal(computeArchiveCutoff(now, 10), '2026-02-23T08:30:00.000Z');
});

test('computeArchiveCutoff supports fractional days', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');

  // Fractional ages are a legal input path (neither the route nor the service
  // rounds `days`), so lock in sub-day arithmetic.
  assert.equal(computeArchiveCutoff(now, 0.5), '2026-07-18T00:00:00.000Z');
  assert.equal(computeArchiveCutoff(now, 2.5), '2026-07-16T00:00:00.000Z');
});

test('bulkArchiveSessionsOlderThan archives only the stale sessions and reports the count', async () => {
  await withIsolatedDatabase(async () => {
    // Years old: comfortably beyond any realistic cutoff.
    sessionsDb.createSession('stale', 'claude', '/workspace/demo', 'Stale', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    // Freshly created (CURRENT_TIMESTAMP): well within the cutoff.
    sessionsDb.createAppSession('fresh', 'claude', '/workspace/demo');

    const result = sessionsService.bulkArchiveSessionsOlderThan(30);

    assert.equal(result.archivedCount, 1);
    assert.deepEqual(result.sessionIds, ['stale']);
    assert.equal(sessionsDb.getSessionById('stale')?.isArchived, 1);
    assert.equal(sessionsDb.getSessionById('fresh')?.isArchived, 0);
  });
});

test('bulkArchiveSessionsOlderThan rejects a non-positive age', async () => {
  await withIsolatedDatabase(async () => {
    for (const badDays of [0, -5, Number.NaN]) {
      assert.throws(
        () => sessionsService.bulkArchiveSessionsOlderThan(badDays),
        /positive number/,
        `days=${badDays} should be rejected`,
      );
    }
  });
});
