import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '../index.js';
import { vapidKeysDb } from './vapid-keys.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'vapid-keys-'));

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

test('getVapidKeys returns null before any key pair is stored', async () => {
  await withIsolatedDatabase(async () => {
    assert.equal(vapidKeysDb.getVapidKeys(), null);
  });
});

test('getVapidKeys returns the most recently created key pair', async () => {
  await withIsolatedDatabase(async () => {
    vapidKeysDb.createVapidKeys('public-old', 'private-old');
    vapidKeysDb.createVapidKeys('public-new', 'private-new');

    assert.deepEqual(vapidKeysDb.getVapidKeys(), {
      publicKey: 'public-new',
      privateKey: 'private-new',
    });
  });
});
