import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';

/**
 * Runs `runTest` against a fresh temp database with VITE_AUTH_DISABLED forced to
 * `authDisabled`. Both DATABASE_PATH and VITE_AUTH_DISABLED are saved and
 * restored so the flag never leaks into other suites in the same process.
 */
async function withIsolatedDatabase(
  authDisabled: boolean,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousAuthDisabled = process.env.VITE_AUTH_DISABLED;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auth-disabled-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.VITE_AUTH_DISABLED = authDisabled ? 'true' : 'false';
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
    if (previousAuthDisabled === undefined) {
      delete process.env.VITE_AUTH_DISABLED;
    } else {
      process.env.VITE_AUTH_DISABLED = previousAuthDisabled;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function countUsers(): number {
  const row = getConnection()
    .prepare('SELECT COUNT(*) as count FROM users')
    .get() as { count: number };
  return row.count;
}

test('seeds the single default user when auth is disabled', async () => {
  await withIsolatedDatabase(true, () => {
    assert.equal(userDb.hasUsers(), true);
    const user = userDb.getFirstUser();
    assert.ok(user, 'expected a seeded user');
    assert.equal(user?.username, 'local');
  });
});

test('seeding is idempotent — re-init keeps exactly one user', async () => {
  await withIsolatedDatabase(true, async () => {
    assert.equal(countUsers(), 1);
    // A second init pass (e.g. server restart) must not create another user.
    await initializeDatabase();
    assert.equal(countUsers(), 1);
    assert.equal(userDb.getFirstUser()?.username, 'local');
  });
});

test('does not seed a user when auth is enabled (default)', async () => {
  await withIsolatedDatabase(false, () => {
    assert.equal(userDb.hasUsers(), false);
    assert.equal(countUsers(), 0);
  });
});
