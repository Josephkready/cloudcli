import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';

import { getProjectsWithSessions } from './projects-with-sessions-fetch.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-fetch-'));
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

// The sidebar renders Done from these fields on the /api/projects payload, so the
// mapper must carry them through — assert against the actual service output.
test('getProjectsWithSessions surfaces last_completed_at / last_viewed_at', async () => {
  await withIsolatedDatabase(async () => {
    projectsDb.createProjectPath('/workspace/done-proj', null);
    sessionsDb.createAppSession('done-sess', 'claude', '/workspace/done-proj');
    sessionsDb.setLastCompletedAt('done-sess');

    const projects = await getProjectsWithSessions({ skipSynchronization: true });
    const session = projects
      .flatMap((project) => project.sessions)
      .find((candidate) => candidate.id === 'done-sess');

    assert.ok(session, 'the seeded session should appear in the projects payload');
    assert.ok(session?.last_completed_at, 'last_completed_at should be surfaced (session is Done)');
    assert.equal(session?.last_viewed_at, null, 'unviewed session keeps last_viewed_at null');
  });
});
