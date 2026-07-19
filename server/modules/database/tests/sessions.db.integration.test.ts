import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
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

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

test('last_completed_at / last_viewed_at back the durable Done state', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-done', 'claude', '/workspace/demo-project', 'Done Session');

    // Fresh row: never completed, never viewed.
    const initial = sessionsDb.getSessionById('session-done');
    assert.equal(initial?.last_completed_at, null);
    assert.equal(initial?.last_viewed_at, null);

    // A run finishes → last_completed_at set (Done, since never viewed).
    sessionsDb.setLastCompletedAt('session-done');
    const completed = sessionsDb.getSessionById('session-done');
    assert.ok(completed?.last_completed_at, 'last_completed_at should be set on completion');
    assert.equal(completed?.last_viewed_at, null);
    // Normalized to canonical ISO like created_at/updated_at, not raw SQLite.
    assert.match(completed!.last_completed_at!, /^\d{4}-\d{2}-\d{2}T.*Z$/);

    // Opening the session stamps last_viewed_at → clears Done.
    sessionsDb.setLastViewedAt('session-done');
    const viewed = sessionsDb.getSessionById('session-done');
    assert.ok(viewed?.last_viewed_at, 'last_viewed_at should be set on view');
    assert.match(viewed!.last_viewed_at!, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

test('createSession preserves archived state on re-sync (fork: startup rescan must not un-archive)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    // A re-sync (startup scan / file-watcher discovering the same transcript)
    // must NOT un-archive the row — otherwise every restart wipes archives.
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const session = sessionsDb.getSessionById('session-reused');

    // Stays archived + hidden from the active list...
    assert.equal(activeSessions.length, 0);
    assert.equal(archivedSessions.length, 1);
    assert.equal(archivedSessions[0]?.session_id, 'session-reused');
    assert.equal(session?.isArchived, 1);
    // ...but other fields still refresh on re-sync.
    assert.equal(session?.custom_name, 'Updated Name');
  });
});

// Longer than the 60-char default min-length gate, so length is never the
// reason a row is included/excluded in the eligibility tests below.
const LONG_TITLE = 'Please investigate why the audio processing backend keeps dropping content on migration';
const OTHER_LONG_TITLE = 'We are working on a brand new design document for maximizing daily mental performance';

test('getSessionsNeedingAiTitle returns only raw, long, active titles and respects name_source', async () => {
  await withIsolatedDatabase(() => {
    const project = '/workspace/titles-project';

    // Raw synchronizer-derived long title -> eligible.
    sessionsDb.createSession('raw-long', 'claude', project, LONG_TITLE);
    // Short raw title -> excluded by the length gate.
    sessionsDb.createSession('raw-short', 'claude', project, 'Fix the bug');
    // Provider placeholder -> excluded.
    sessionsDb.createSession('untitled', 'claude', project, 'Untitled Claude Session');
    // Manually renamed (even though still long) -> excluded.
    sessionsDb.createSession('user-long', 'claude', project, LONG_TITLE);
    sessionsDb.updateSessionCustomName('user-long', OTHER_LONG_TITLE, 'user');
    // Already rewritten by the worker (even if re-set to a long value) -> excluded.
    sessionsDb.createSession('ai-long', 'claude', project, LONG_TITLE);
    sessionsDb.updateSessionCustomName('ai-long', OTHER_LONG_TITLE, 'ai');
    // Archived long raw title -> excluded.
    sessionsDb.createSession('archived-long', 'claude', project, LONG_TITLE);
    sessionsDb.updateSessionIsArchived('archived-long', true);

    const eligible = sessionsDb.getSessionsNeedingAiTitle(60, 100);
    assert.deepEqual(
      eligible.map((row) => row.session_id),
      ['raw-long'],
    );
  });
});

test('getSessionsNeedingAiTitle orders newest-first and honors the batch limit', async () => {
  await withIsolatedDatabase(() => {
    const project = '/workspace/titles-order';
    sessionsDb.createSession('older', 'claude', project, LONG_TITLE, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    sessionsDb.createSession('newer', 'claude', project, OTHER_LONG_TITLE, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');

    const firstOnly = sessionsDb.getSessionsNeedingAiTitle(60, 1);
    assert.deepEqual(firstOnly.map((row) => row.session_id), ['newer']);

    const both = sessionsDb.getSessionsNeedingAiTitle(60, 100);
    assert.deepEqual(both.map((row) => row.session_id), ['newer', 'older']);
  });
});

test('updateSessionCustomName records name_source only when a source is given', async () => {
  await withIsolatedDatabase(() => {
    const project = '/workspace/titles-source';

    // No source: synchronizer-style update leaves the row eligible.
    sessionsDb.createSession('sync-touched', 'claude', project, LONG_TITLE);
    sessionsDb.updateSessionCustomName('sync-touched', OTHER_LONG_TITLE);
    let row = sessionsDb.getSessionById('sync-touched');
    assert.equal(row?.custom_name, OTHER_LONG_TITLE);
    assert.equal(row?.name_source, null);

    // 'ai' source updates the title and marks it done.
    sessionsDb.updateSessionCustomName('sync-touched', 'Audio Backend Fix', 'ai');
    row = sessionsDb.getSessionById('sync-touched');
    assert.equal(row?.custom_name, 'Audio Backend Fix');
    assert.equal(row?.name_source, 'ai');

    // 'user' source marks a manual rename.
    sessionsDb.createSession('renamed', 'claude', project, LONG_TITLE);
    sessionsDb.updateSessionCustomName('renamed', 'My Notes', 'user');
    assert.equal(sessionsDb.getSessionById('renamed')?.name_source, 'user');

    assert.equal(sessionsDb.getSessionsNeedingAiTitle(60, 100).length, 0);
  });
});

test('createSession does not overwrite AI- or user-owned titles on re-sync', async () => {
  await withIsolatedDatabase(() => {
    const project = '/workspace/sticky-titles';

    // Simulates a provider whose synchronizer recomputes the name from the raw
    // transcript on every scan and always passes a fresh (long) name back in.
    sessionsDb.createSession('ai-row', 'codex', project, LONG_TITLE);
    sessionsDb.updateSessionCustomName('ai-row', 'Short AI Title', 'ai');
    sessionsDb.createSession('user-row', 'codex', project, LONG_TITLE);
    sessionsDb.updateSessionCustomName('user-row', 'My Manual Name', 'user');
    sessionsDb.createSession('raw-row', 'codex', project, LONG_TITLE);

    // Re-sync (server restart / file-watcher) re-runs createSession with a new
    // long name for every row.
    sessionsDb.createSession('ai-row', 'codex', project, OTHER_LONG_TITLE);
    sessionsDb.createSession('user-row', 'codex', project, OTHER_LONG_TITLE);
    sessionsDb.createSession('raw-row', 'codex', project, OTHER_LONG_TITLE);

    // Owned titles survive; only the raw one refreshes from disk.
    assert.equal(sessionsDb.getSessionById('ai-row')?.custom_name, 'Short AI Title');
    assert.equal(sessionsDb.getSessionById('user-row')?.custom_name, 'My Manual Name');
    assert.equal(sessionsDb.getSessionById('raw-row')?.custom_name, OTHER_LONG_TITLE);
  });
});

test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});
