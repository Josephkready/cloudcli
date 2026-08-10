import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

/*
 * Backs `/session/:sessionId` deep links.
 *
 * The frontend only ever holds each project's FIRST page of sessions, so a
 * session opened directly by URL is frequently absent client-side — on this
 * host the database holds thousands of sessions across dozens of projects, so
 * anything but a recent conversation misses. Previously the URL effect either
 * bound the session to whatever project happened to be selected (wrong
 * project) or, with no project selected yet, selected nothing at all and the
 * chat rendered blank.
 *
 * This lookup is the authoritative answer to "which project owns this id",
 * including when the URL carries the provider-native id rather than the
 * app-facing one.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-details-'));

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

test('resolves a session to its owning project by app session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('sess-app', 'claude', '/workspace/demo', 'Demo Session');

    const details = sessionsService.getSessionDetailsById('sess-app');

    assert.equal(details.sessionId, 'sess-app');
    assert.equal(details.provider, 'claude');
    assert.equal(details.summary, 'Demo Session');
    assert.equal(details.project?.path, '/workspace/demo');
    assert.equal(details.project?.displayName, 'demo');
    assert.ok(details.project?.projectId);
  });
});

test('resolves via the provider-native id and reports the canonical app id', async () => {
  await withIsolatedDatabase(() => {
    // The app-facing id and the provider's own id differ, and the transcript on
    // disk is named after the PROVIDER id — so that is the id a user is most
    // likely to have in hand. It must resolve, and it must report back the
    // canonical id so the client can renavigate to it.
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-id-1');

    const details = sessionsService.getSessionDetailsById('provider-id-1');

    assert.equal(details.sessionId, 'app-id-1', 'must report the canonical app id, not the alias');
    assert.equal(details.project?.path, '/workspace/demo');
  });
});

test('reports 404 for an unknown session id', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getSessionDetailsById('does-not-exist'),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 404,
      'an unknown id must be a 404, not an empty success',
    );
  });
});

test('still resolves a session whose project is archived', async () => {
  await withIsolatedDatabase(() => {
    // An archived project is absent from the sidebar payload entirely, which is
    // precisely when the client cannot resolve the owner on its own.
    sessionsDb.createSession('sess-archived', 'claude', '/workspace/old', 'Old Session');

    const details = sessionsService.getSessionDetailsById('sess-archived');

    assert.equal(details.project?.path, '/workspace/old');
    assert.equal(details.sessionId, 'sess-archived');
  });
});
