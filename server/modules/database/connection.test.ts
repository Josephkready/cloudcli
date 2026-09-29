import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { getConnection, closeConnection, getDatabasePath } from './connection.js';

const originalDatabasePath = process.env.DATABASE_PATH;

test.after(async () => {
  closeConnection();
  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }
});

test('getConnection enables WAL mode + NORMAL synchronous + a busy_timeout for a real file db', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-connection-test-'));
  const dbPath = path.join(tempDir, 'auth.db');
  process.env.DATABASE_PATH = dbPath;
  try {
    const db = getConnection();
    assert.equal(getDatabasePath(), dbPath);
    assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
    assert.equal(db.pragma('synchronous', { simple: true }), 1); // NORMAL == 1
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  } finally {
    closeConnection();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closeConnection checkpoints the WAL without throwing and clears the singleton', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-connection-test-'));
  const dbPath = path.join(tempDir, 'auth.db');
  process.env.DATABASE_PATH = dbPath;
  try {
    const db = getConnection();
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO t DEFAULT VALUES').run();

    assert.doesNotThrow(() => closeConnection());

    // getConnection() re-opens a fresh instance after close; the write
    // above must have survived the WAL checkpoint performed on close.
    const reopened = getConnection();
    const row = reopened.prepare('SELECT COUNT(*) as count FROM t').get() as { count: number };
    assert.equal(row.count, 1);
  } finally {
    closeConnection();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('getConnection skips WAL pragmas for :memory: databases', () => {
  process.env.DATABASE_PATH = ':memory:';
  try {
    const db = getConnection();
    assert.notEqual(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
  } finally {
    closeConnection();
  }
});
