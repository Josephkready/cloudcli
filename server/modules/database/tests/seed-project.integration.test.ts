import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';

/**
 * seed-project.ts is how the e2e harness registers its project now that there is
 * no create-project endpoint, so run it the way e2e/fixtures.ts does: as its own
 * process against a throwaway DATABASE_PATH.
 */
const TSX = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
const SCRIPT = 'server/modules/database/seed-project.ts';

function runSeed(databasePath: string, args: string[]) {
  return spawnSync(TSX, ['--tsconfig', 'server/tsconfig.json', SCRIPT, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });
}

test('seed-project registers the project with its display name, and refuses a duplicate', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'seed-project-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const projectPath = path.join(tempDirectory, 'e2e-project');
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    const first = runSeed(databasePath, [projectPath, 'E2E Project']);
    assert.equal(first.status, 0, first.stderr);

    closeConnection();
    process.env.DATABASE_PATH = databasePath;
    const row = projectsDb.getProjectPath(projectPath);
    assert.equal(row?.custom_project_name, 'E2E Project');
    assert.equal(row?.isArchived, 0);
    closeConnection();

    const again = runSeed(databasePath, [projectPath, 'E2E Project']);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /expected a fresh project, got active_conflict/);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('seed-project exits 2 with usage when no project path is given', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'seed-project-'));
  try {
    const result = runSeed(path.join(tempDirectory, 'auth.db'), []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: seed-project\.ts/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
