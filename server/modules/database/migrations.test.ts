import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { INIT_SCHEMA_SQL } from './schema.js';
import { runMigrations } from './migrations.js';

test('steady-state migrations do not rewrite populated session rows', () => {
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
      CREATE TABLE session_update_audit (update_count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO session_update_audit DEFAULT VALUES;
      CREATE TRIGGER audit_session_updates
      AFTER UPDATE ON sessions
      BEGIN
        UPDATE session_update_audit SET update_count = update_count + 1;
      END;
    `);

    runMigrations(db);

    const audit = db.prepare('SELECT update_count FROM session_update_audit').get() as {
      update_count: number;
    };
    assert.equal(audit.update_count, 0);
  } finally {
    db.close();
  }
});
