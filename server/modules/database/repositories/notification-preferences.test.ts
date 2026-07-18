import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, notificationPreferencesDb, userDb } from '../index.js';
import { getConnection } from '../connection.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'notification-preferences-'));
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

// Back-compat guard for #150: the Electron desktop-notification channel was
// removed. Preferences persisted while it existed can still carry a `desktop`
// boolean; reading them must drop that dead key rather than resurface it.
test('a legacy stored desktop channel preference is dropped on read', async () => {
  await withIsolatedDatabase(async () => {
    const user = userDb.createUser('prefs-legacy', 'hash');
    const userId = Number(user.id);

    // Write a raw legacy row directly, bypassing updatePreferences() so the
    // desktop key is actually persisted (the write path already normalizes).
    getConnection()
      .prepare(
        'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
      )
      .run(
        userId,
        JSON.stringify({
          channels: { inApp: true, webPush: true, desktop: true, sound: false },
          events: { actionRequired: true, stop: true, error: true },
        })
      );

    const prefs = notificationPreferencesDb.getPreferences(userId);

    assert.ok(!('desktop' in prefs.channels), 'dead desktop channel key must not survive normalization');
    assert.equal(prefs.channels.webPush, true, 'live channels are preserved');
    assert.equal(prefs.channels.inApp, true);
    assert.equal(prefs.channels.sound, false);
  });
});

// The desktop key is dropped *specifically* (it is named in the exclude list),
// not because normalization strips every unknown channel. Unknown channels are
// preserved for forward-compat, so this guards that the desktop drop is intentional.
test('unknown extra channels survive normalization while desktop does not', async () => {
  await withIsolatedDatabase(async () => {
    const user = userDb.createUser('prefs-extra', 'hash');
    const userId = Number(user.id);

    getConnection()
      .prepare(
        'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
      )
      .run(
        userId,
        JSON.stringify({
          channels: { desktop: true, slack: true },
          events: {},
        })
      );

    const prefs = notificationPreferencesDb.getPreferences(userId) as {
      channels: Record<string, boolean>;
    };

    assert.ok(!('desktop' in prefs.channels), 'desktop is actively excluded');
    assert.equal(prefs.channels.slack, true, 'other extra channels are kept for forward-compat');
  });
});
