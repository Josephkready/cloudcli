import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'project-delete-service-test-'));
process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

const { initializeDatabase, projectsDb, sessionsDb, closeConnection } = await import(
  '@/modules/database/index.js'
);
await initializeDatabase();
const { deleteOrArchiveProject } = await import(
  '@/modules/projects/services/project-delete.service.js'
);

test.after(async () => {
  closeConnection();
  await rm(tempDirectory, { recursive: true, force: true });
});

test('deleteOrArchiveProject(force=true) concurrently removes every distinct jsonl file and clears the DB rows', async () => {
  const projectPath = path.join(tempDirectory, 'force-delete-project');
  const jsonlDir = path.join(tempDirectory, 'jsonl-force-delete');
  await mkdir(jsonlDir, { recursive: true });

  const { project } = projectsDb.createProjectPath(projectPath);
  assert.ok(project);

  // More sessions than the service's UNLINK_CONCURRENCY (16) to exercise the
  // bounded worker pool rather than a small unbounded Promise.all.
  const SESSION_COUNT = 40;
  const jsonlPaths: string[] = [];
  for (let i = 0; i < SESSION_COUNT; i++) {
    const jsonlPath = path.join(jsonlDir, `session-${i}.jsonl`);
    await writeFile(jsonlPath, '{}\n');
    jsonlPaths.push(jsonlPath);
    sessionsDb.createSession(`provider-session-${i}`, 'claude', projectPath, undefined, undefined, undefined, jsonlPath);
  }

  for (const jsonlPath of jsonlPaths) {
    assert.ok(existsSync(jsonlPath), `expected ${jsonlPath} to exist before delete`);
  }

  await deleteOrArchiveProject(project!.project_id, true);

  for (const jsonlPath of jsonlPaths) {
    assert.equal(existsSync(jsonlPath), false, `expected ${jsonlPath} to be removed`);
  }
  assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath).length, 0);
  assert.equal(projectsDb.getProjectById(project!.project_id), null);
});

test('deleteOrArchiveProject(force=true) tolerates a jsonl file that is already missing on disk', async () => {
  const projectPath = path.join(tempDirectory, 'missing-jsonl-project');
  const { project } = projectsDb.createProjectPath(projectPath);
  assert.ok(project);

  const missingJsonlPath = path.join(tempDirectory, 'jsonl-force-delete', 'never-written.jsonl');
  sessionsDb.createSession('provider-session-missing', 'claude', projectPath, undefined, undefined, undefined, missingJsonlPath);

  await assert.doesNotReject(() => deleteOrArchiveProject(project!.project_id, true));
  assert.equal(projectsDb.getProjectById(project!.project_id), null);
});
