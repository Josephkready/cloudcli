import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FEATURE_KEYS } from '../../../../shared/featureKeys.js';
import { closeConnection, getConnection } from '../connection.js';
import { initializeDatabase } from '../init-db.js';
import { runMigrations } from '../migrations.js';

import { featureUsageDb } from './feature-usage.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousEnabled = process.env.FEATURE_USAGE_ENABLED;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'feature-usage-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  delete process.env.FEATURE_USAGE_ENABLED;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousEnabled === undefined) delete process.env.FEATURE_USAGE_ENABLED;
    else process.env.FEATURE_USAGE_ENABLED = previousEnabled;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const entryFor = (key: string) =>
  featureUsageDb.listUsage().find((entry) => entry.featureKey === key);

test('the feature_usage migration is idempotent', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    featureUsageDb.recordFeatureUses(['git.commit']);

    // Re-running every migration must not throw and must not wipe the counters
    // an earlier boot recorded.
    runMigrations(db);
    runMigrations(db);

    assert.equal(entryFor('git.commit')?.useCount, 1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feature_usage'")
      .all();
    assert.equal(tables.length, 1);
  });
});

test('recordFeatureUses inserts, then increments, and keeps first/last used correct', async () => {
  await withIsolatedDatabase(() => {
    const first = new Date('2026-01-01T10:00:00Z');
    const second = new Date('2026-03-04T18:30:00Z');

    assert.equal(featureUsageDb.recordFeatureUses(['git.commit'], first), 1);
    const afterInsert = entryFor('git.commit');
    assert.equal(afterInsert?.useCount, 1);
    assert.equal(afterInsert?.firstUsedAt, '2026-01-01 10:00:00');
    assert.equal(afterInsert?.lastUsedAt, '2026-01-01 10:00:00');

    assert.equal(featureUsageDb.recordFeatureUses(['git.commit'], second), 1);
    const afterIncrement = entryFor('git.commit');
    assert.equal(afterIncrement?.useCount, 2);
    // first_used_at is preserved; last_used_at moves forward.
    assert.equal(afterIncrement?.firstUsedAt, '2026-01-01 10:00:00');
    assert.equal(afterIncrement?.lastUsedAt, '2026-03-04 18:30:00');
  });
});

test('a batch is tallied per key and unknown keys are dropped', async () => {
  await withIsolatedDatabase(() => {
    const recorded = featureUsageDb.recordFeatureUses([
      'chat.send',
      'chat.send',
      'chat.send',
      'git.stage',
      'not.a.real.key',
      42,
      null,
    ]);

    assert.equal(recorded, 4);
    assert.equal(entryFor('chat.send')?.useCount, 3);
    assert.equal(entryFor('git.stage')?.useCount, 1);

    const storedKeys = getConnection()
      .prepare('SELECT feature_key FROM feature_usage')
      .all() as { feature_key: string }[];
    assert.deepEqual(
      storedKeys.map((row) => row.feature_key).sort(),
      ['chat.send', 'git.stage'],
    );
  });
});

test('recording is a no-op when FEATURE_USAGE_ENABLED is off', async () => {
  await withIsolatedDatabase(() => {
    for (const off of ['false', '0', 'off', 'no', 'FALSE']) {
      process.env.FEATURE_USAGE_ENABLED = off;
      assert.equal(featureUsageDb.isEnabled(), false, off);
      assert.equal(featureUsageDb.recordFeatureUses(['chat.send']), 0, off);
    }
    assert.equal(entryFor('chat.send')?.useCount, 0);

    // Anything else — including the variable being unset or blank — leaves
    // recording on, so the counters work without configuration.
    for (const on of ['true', '1', '', 'anything']) {
      process.env.FEATURE_USAGE_ENABLED = on;
      assert.equal(featureUsageDb.isEnabled(), true, on);
    }
    delete process.env.FEATURE_USAGE_ENABLED;
    assert.equal(featureUsageDb.isEnabled(), true);
    assert.equal(featureUsageDb.recordFeatureUses(['chat.send']), 1);
  });
});

test('a throwing database does not propagate out of recordFeatureUses', async () => {
  await withIsolatedDatabase(() => {
    // A genuinely broken database: the table the upsert targets is gone, so
    // `prepare` throws inside the repository exactly as a corrupt or
    // concurrently-migrating file would.
    getConnection().exec('DROP TABLE feature_usage');

    assert.doesNotThrow(() => featureUsageDb.recordFeatureUses(['chat.send']));
    assert.equal(featureUsageDb.recordFeatureUses(['chat.send']), 0);
  });
});

test('a closed connection does not propagate out of recordFeatureUses', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.close();

    // Every statement on a closed handle throws; the guarantee is that none of
    // it reaches the caller on the user-action path.
    assert.doesNotThrow(() => featureUsageDb.recordFeatureUses(['chat.send']));
    assert.equal(featureUsageDb.recordFeatureUses(['chat.send']), 0);
  });
});

test('listUsage returns every known key, zero-filled and least-used first', async () => {
  await withIsolatedDatabase(() => {
    featureUsageDb.recordFeatureUses(
      ['chat.send', 'chat.send', 'git.commit'],
      new Date('2026-02-02T09:00:00Z'),
    );

    const entries = featureUsageDb.listUsage();

    // Every key in the inventory is present, including the untouched ones.
    assert.equal(entries.length, FEATURE_KEYS.length);
    assert.deepEqual(
      [...entries.map((entry) => entry.featureKey)].sort(),
      [...FEATURE_KEYS].sort(),
    );

    // Sorted ascending by count, so the never-used ones float to the top.
    const counts = entries.map((entry) => entry.useCount);
    assert.deepEqual(counts, [...counts].sort((a, b) => a - b));
    assert.equal(counts[0], 0);
    assert.equal(entries[entries.length - 1]?.featureKey, 'chat.send');
    assert.equal(entries[entries.length - 1]?.useCount, 2);
    assert.equal(entries[entries.length - 2]?.featureKey, 'git.commit');

    // A never-used key reads as an explicit zero with no timestamps.
    const untouched = entries[0];
    assert.equal(untouched?.useCount, 0);
    assert.equal(untouched?.firstUsedAt, null);
    assert.equal(untouched?.lastUsedAt, null);
  });
});

test('among equal counts the stalest feature sorts first', async () => {
  await withIsolatedDatabase(() => {
    featureUsageDb.recordFeatureUses(['git.revert'], new Date('2026-01-01T00:00:00Z'));
    featureUsageDb.recordFeatureUses(['git.discard'], new Date('2026-06-01T00:00:00Z'));

    const used = featureUsageDb.listUsage().filter((entry) => entry.useCount > 0);
    assert.deepEqual(
      used.map((entry) => entry.featureKey),
      ['git.revert', 'git.discard'],
    );
  });
});

test('clearUsage empties the table but keeps the inventory visible', async () => {
  await withIsolatedDatabase(() => {
    featureUsageDb.recordFeatureUses(['chat.send', 'git.commit']);
    assert.equal(featureUsageDb.clearUsage(), 2);

    const entries = featureUsageDb.listUsage();
    assert.equal(entries.length, FEATURE_KEYS.length);
    assert.ok(entries.every((entry) => entry.useCount === 0 && entry.lastUsedAt === null));

    // Clearing an already-empty table is a no-op, not an error.
    assert.equal(featureUsageDb.clearUsage(), 0);
  });
});

test('listUsage works against a database that has never been migrated', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'feature-usage-fresh-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

  try {
    // No initializeDatabase() call: the CLI readout has to work on a file the
    // new server has not booted against yet.
    const entries = featureUsageDb.listUsage();
    assert.equal(entries.length, FEATURE_KEYS.length);
    assert.ok(entries.every((entry) => entry.useCount === 0));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
