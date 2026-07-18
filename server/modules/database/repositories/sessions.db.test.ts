import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '../index.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
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

const PROJECT_PATH = '/repos/archive-by-age';
const OLD = '2026-01-01T00:00:00.000Z';
const RECENT = '2026-07-18T00:00:00.000Z';
const CUTOFF = '2026-06-01T00:00:00.000Z';

// createSession keys the row by the provider-native id and returns it as the
// app session_id, so the seeded ids double as the expected archive result.
function seedSession(
  id: string,
  { created = OLD, updated }: { created?: string; updated: string },
): void {
  sessionsDb.createSession(id, 'claude', PROJECT_PATH, id, created, updated);
}

test('archiveSessionsOlderThan archives only sessions idle before the cutoff', async () => {
  await withIsolatedDatabase(async () => {
    seedSession('old-1', { updated: OLD });
    seedSession('old-2', { updated: OLD });
    seedSession('recent-1', { updated: RECENT });

    const archived = sessionsDb.archiveSessionsOlderThan(CUTOFF);

    assert.deepEqual([...archived].sort(), ['old-1', 'old-2'], 'returns exactly the aged ids');
    assert.equal(sessionsDb.getSessionById('old-1')?.isArchived, 1);
    assert.equal(sessionsDb.getSessionById('old-2')?.isArchived, 1);
    assert.equal(sessionsDb.getSessionById('recent-1')?.isArchived, 0, 'recent session stays active');
  });
});

test('archiveSessionsOlderThan judges age by updated_at, not created_at', async () => {
  await withIsolatedDatabase(async () => {
    // Created long ago but touched recently: an active conversation, not stale.
    seedSession('revived', { created: OLD, updated: RECENT });

    const archived = sessionsDb.archiveSessionsOlderThan(CUTOFF);

    assert.deepEqual(archived, [], 'a recently-updated session is not archived');
    assert.equal(sessionsDb.getSessionById('revived')?.isArchived, 0);
  });
});

test('archiveSessionsOlderThan is idempotent and skips already-archived rows', async () => {
  await withIsolatedDatabase(async () => {
    seedSession('old-1', { updated: OLD });

    const firstPass = sessionsDb.archiveSessionsOlderThan(CUTOFF);
    assert.deepEqual(firstPass, ['old-1']);

    const secondPass = sessionsDb.archiveSessionsOlderThan(CUTOFF);
    assert.deepEqual(secondPass, [], 'a second pass re-archives nothing');
  });
});

test('archiveSessionsOlderThan returns an empty list when nothing qualifies', async () => {
  await withIsolatedDatabase(async () => {
    seedSession('recent-1', { updated: RECENT });

    const archived = sessionsDb.archiveSessionsOlderThan(CUTOFF);

    assert.deepEqual(archived, []);
    assert.equal(sessionsDb.getSessionById('recent-1')?.isArchived, 0);
  });
});
