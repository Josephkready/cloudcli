import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { INIT_SCHEMA_SQL } from './schema.js';
import { runMigrations } from './migrations.js';

test('session backfills update null legacy fields once without rewriting populated rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec(INIT_SCHEMA_SQL);
    runMigrations(db);
    db.exec(`
      INSERT INTO projects (project_id, project_path) VALUES ('project-1', '/workspace/project-1');
      INSERT INTO sessions (
        session_id, provider, provider_session_id, project_path,
        isArchived, created_at, updated_at
      ) VALUES (
        'session-1', 'claude', 'session-1', '/workspace/project-1',
        0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO sessions (
        session_id, provider, provider_session_id, project_path,
        isArchived, created_at, updated_at
      ) VALUES (
        'session-null', 'claude', 'session-null', '/workspace/project-1',
        NULL, NULL, NULL
      );
      CREATE TABLE session_update_audit (session_id TEXT NOT NULL);
      CREATE TRIGGER audit_session_updates
      AFTER UPDATE ON sessions
      BEGIN
        INSERT INTO session_update_audit (session_id) VALUES (NEW.session_id);
      END;
    `);

    runMigrations(db);
    runMigrations(db);

    const audit = db.prepare(`
      SELECT session_id, count(*) AS update_count
      FROM session_update_audit
      GROUP BY session_id
    `).all() as Array<{ session_id: string; update_count: number }>;
    assert.deepEqual(audit, [{ session_id: 'session-null', update_count: 3 }]);

    const backfilled = db.prepare(`
      SELECT isArchived, created_at, updated_at FROM sessions WHERE session_id = 'session-null'
    `).get() as { isArchived: number | null; created_at: string | null; updated_at: string | null };
    assert.equal(backfilled.isArchived, 0);
    assert.ok(backfilled.created_at);
    assert.ok(backfilled.updated_at);
  } finally {
    db.close();
  }
});

test('legacy users gain a durable zero-valued token version exactly once', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        is_active BOOLEAN DEFAULT 1,
        git_name TEXT,
        git_email TEXT,
        has_completed_onboarding BOOLEAN DEFAULT 0
      );
      INSERT INTO users (username, password_hash) VALUES ('alice', 'hash');
    `);

    runMigrations(db);
    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    assert.equal(columns.filter((column) => column.name === 'token_version').length, 1);
    const user = db.prepare(
      "SELECT token_version FROM users WHERE username = 'alice'"
    ).get() as { token_version: number };
    assert.equal(user.token_version, 0);
  } finally {
    db.close();
  }
});
