import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import { sessionsService } from './sessions.service.js';

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
