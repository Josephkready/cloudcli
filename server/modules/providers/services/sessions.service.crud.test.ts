import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';

import { sessionsService } from './sessions.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-service-crud-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('listProviderIds returns every registered provider id', () => {
  const ids = sessionsService.listProviderIds();
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('codex'));
  assert.ok(ids.includes('antigravity'));
});

test('listRunningSessions reflects the chat run registry (empty when nothing is running)', () => {
  assert.deepEqual(sessionsService.listRunningSessions(), []);
});

test('normalizeMessage delegates to the resolved provider session adapter', () => {
  const normalized = sessionsService.normalizeMessage('claude', {
    type: 'content_block_delta',
    delta: { text: 'hi' },
  }, 'sess-1');
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].kind, 'stream_delta');
});

test('createAppSession allocates a fresh row with no provider_session_id yet', async () => {
  await withIsolatedDatabase(async () => {
    const result = sessionsService.createAppSession('claude', '/workspace/demo');
    assert.equal(result.provider, 'claude');
    assert.equal(result.projectPath, '/workspace/demo');
    assert.ok(result.sessionId);

    const row = sessionsDb.getSessionById(result.sessionId);
    assert.ok(row);
    assert.equal(row?.provider_session_id, null);
  });
});

test('createAppSession rejects a blank projectPath', async () => {
  await withIsolatedDatabase(async () => {
    assert.throws(() => sessionsService.createAppSession('claude', '   '), /projectPath is required/);
  });
});

test('fetchHistory throws for an unknown session id', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(() => sessionsService.fetchHistory('does-not-exist'), /was not found/);
  });
});

test('getSessionDetailsById resolves by app id, falls back to provider id, and includes project metadata', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath('/workspace/demo', 'Demo Project');
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo');
    sessionsDb.updateSessionCustomName('app-id-1', 'My chat', 'user');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-id-1');

    const byAppId = sessionsService.getSessionDetailsById('app-id-1');
    assert.equal(byAppId.sessionId, 'app-id-1');
    assert.equal(byAppId.summary, 'My chat');
    assert.equal(byAppId.project?.displayName, 'Demo Project');

    // Provider-id fallback: getSessionByProviderSessionId is used once the
    // direct app-id lookup misses — the canonical app id still comes back.
    const byProviderId = sessionsService.getSessionDetailsById('provider-id-1');
    assert.equal(byProviderId.sessionId, 'app-id-1');
  });
});

test('getSessionDetailsById throws for an unknown id', async () => {
  await withIsolatedDatabase(async () => {
    assert.throws(() => sessionsService.getSessionDetailsById('nope'), /was not found/);
  });
});

test('listArchivedSessions groups by project and falls back to the session id as a title', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('archived-1', 'claude', '/workspace/demo', '', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    sessionsDb.updateSessionIsArchived('archived-1', true);

    const archived = sessionsService.listArchivedSessions();
    assert.equal(archived.length, 1);
    assert.equal(archived[0].sessionId, 'archived-1');
    // No custom_name set — falls back to the session id itself as the title.
    assert.equal(archived[0].sessionTitle, 'archived-1');
    assert.equal(archived[0].projectDisplayName, 'demo');
  });
});

test('deleteOrArchiveSessionById archives by default and force-deletes (with disk cleanup) when asked', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('to-archive', 'claude', '/workspace/demo');
    const archived = await sessionsService.deleteOrArchiveSessionById('to-archive');
    assert.equal(archived.action, 'archived');
    assert.equal(sessionsDb.getSessionById('to-archive')?.isArchived, 1);

    const tempDir = await mkdtemp(path.join(tmpdir(), 'session-transcript-'));
    const transcriptPath = path.join(tempDir, 'session.jsonl');
    await writeFile(transcriptPath, '{}\n', 'utf8');
    sessionsDb.createSession('to-delete', 'claude', '/workspace/demo', undefined, undefined, undefined, transcriptPath);

    const deleted = await sessionsService.deleteOrArchiveSessionById('to-delete', { force: true, deletedFromDisk: true });
    assert.equal(deleted.action, 'deleted');
    assert.equal(deleted.deletedFromDisk, true);
    assert.equal(sessionsDb.getSessionById('to-delete'), null);

    await rm(tempDir, { recursive: true, force: true });
  });
});

test('deleteOrArchiveSessionById throws for an unknown session id', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(() => sessionsService.deleteOrArchiveSessionById('nope'), /was not found/);
  });
});

test('restoreSessionById un-archives a session', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('restore-me', 'claude', '/workspace/demo');
    sessionsDb.updateSessionIsArchived('restore-me', true);

    const result = sessionsService.restoreSessionById('restore-me');
    assert.deepEqual(result, { sessionId: 'restore-me', isArchived: false });
    assert.equal(sessionsDb.getSessionById('restore-me')?.isArchived, 0);
  });
});

test('restoreSessionById throws for an unknown session id', async () => {
  await withIsolatedDatabase(async () => {
    assert.throws(() => sessionsService.restoreSessionById('nope'), /was not found/);
  });
});

test('renameSessionById sets a user-authored custom name', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('rename-me', 'claude', '/workspace/demo');
    const result = sessionsService.renameSessionById('rename-me', 'New Title');
    assert.deepEqual(result, { sessionId: 'rename-me', summary: 'New Title' });
    assert.equal(sessionsDb.getSessionById('rename-me')?.custom_name, 'New Title');
  });
});

test('renameSessionById throws for an unknown session id', async () => {
  await withIsolatedDatabase(async () => {
    assert.throws(() => sessionsService.renameSessionById('nope', 'x'), /was not found/);
  });
});
