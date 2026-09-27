import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

type Harness = {
  projectRoot: string;
  request: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
};

async function withProjectFilesServer(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'project-files-route-')));
  const projectRoot = path.join(tempDirectory, 'project');
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'index.ts'), 'export {};\n');
  await writeFile(path.join(projectRoot, 'README.md'), '# hello\n');

  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  const { closeConnection, initializeDatabase, projectsDb, userDb } = await import('@/modules/database/index.js');
  closeConnection();
  await initializeDatabase();

  const { generateToken } = await import('../../middleware/auth.js');
  const { default: projectFilesRoutes } = await import('../project-files.js');

  const created = userDb.createUser('files-route-user', 'hash');
  const token = generateToken(userDb.getUserById(Number(created.id)));
  const { project } = projectsDb.createProjectPath(projectRoot);
  assert.ok(project);

  const app = express();
  app.use(express.json());
  app.use(projectFilesRoutes);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const request: Harness['request'] = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url.replace(':id', project.project_id)}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    await runTest({ projectRoot, request });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('project file routes stay mounted at their historical paths behind auth', async () => {
  await withProjectFilesServer(async ({ projectRoot, request }) => {
    const tree = await request('GET', '/api/projects/:id/files');
    assert.equal(tree.status, 200);
    assert.deepEqual(tree.body.map((entry: { name: string }) => entry.name), ['src', 'README.md']);

    const read = await request('GET', '/api/projects/:id/file?filePath=README.md');
    assert.equal(read.status, 200);
    assert.equal(read.body.content, '# hello\n');

    const saved = await request('PUT', '/api/projects/:id/file', { filePath: 'README.md', content: '# changed\n' });
    assert.equal(saved.status, 200);
    assert.equal(await readFile(path.join(projectRoot, 'README.md'), 'utf8'), '# changed\n');

    const createdFile = await request('POST', '/api/projects/:id/files/create', { path: 'src', type: 'file', name: 'new.ts' });
    assert.equal(createdFile.status, 200);
    assert.equal(await readFile(path.join(projectRoot, 'src', 'new.ts'), 'utf8'), '');

    const renamed = await request('PUT', '/api/projects/:id/files/rename', { oldPath: 'src/new.ts', newName: 'renamed.ts' });
    assert.equal(renamed.status, 200);
    assert.equal(await readFile(path.join(projectRoot, 'src', 'renamed.ts'), 'utf8'), '');
  });
});

test('project file routes reject traversal outside the project and unknown projects', async () => {
  await withProjectFilesServer(async ({ request }) => {
    const escape = await request('GET', '/api/projects/:id/file?filePath=../../../etc/passwd');
    assert.equal(escape.status, 403);

    const badName = await request('PUT', '/api/projects/:id/files/rename', { oldPath: 'README.md', newName: '../x' });
    assert.equal(badName.status, 400);

    const unknown = await request('GET', '/api/projects/does-not-exist/files');
    assert.equal(unknown.status, 404);
  });
});
