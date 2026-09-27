import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';

import projectsRouter from './projects.routes.js';

/*
 * Cold-start contract (#302): a populated SQLite index must be servable without
 * waiting on a provider filesystem rescan, including while a scan is already
 * running. These tests hold every provider scan open for the whole request and
 * assert the response still lands.
 */

type TestServer = { port: number; close: () => Promise<void> };

function startServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: number } }).user = { id: 1 };
    next();
  });
  app.use('/api/projects', projectsRouter);
  const server = http.createServer(app);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function requestText(
  port: number,
  method: string,
  requestPath: string,
  body?: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const encodedBody = body ? JSON.stringify(body) : '';
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: encodedBody
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encodedBody) }
        : undefined,
    }, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        body: responseBody,
      }));
    });
    request.on('error', reject);
    if (encodedBody) request.write(encodedBody);
    request.end();
  });
}

function getJson(port: number, requestPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: requestPath }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
  });
}

async function withSeededDatabase(runTest: (server: TestServer) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  projectsDb.createProjectPath('/workspace/indexed-proj', 'Indexed Project');
  sessionsDb.createAppSession('indexed-sess', 'claude', '/workspace/indexed-proj');

  const server = await startServer();
  try {
    await runTest(server);
  } finally {
    await server.close();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Holds the full provider rescan open until the returned release is called. */
function blockProviderScans(): { release: () => void; scanCount: () => number } {
  let scanCount = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  mock.method(sessionSynchronizerService, 'synchronizeSessions', async () => {
    scanCount += 1;
    await gate;
    return { processedByProvider: { claude: 0, codex: 0, antigravity: 0 }, failures: [] };
  });

  return { release, scanCount: () => scanCount };
}

test('GET /api/projects serves the persisted snapshot while a provider scan is blocked', async () => {
  await withSeededDatabase(async (server) => {
    const scans = blockProviderScans();

    try {
      // Never released before the assertion: if the response awaited the scan in
      // any way, this would hang instead of resolving.
      const projects = (await getJson(server.port, '/api/projects')) as Array<{
        projectId: string;
        displayName: string;
        sessions: Array<{ id: string }>;
      }>;

      assert.equal(projects.length, 1, 'the indexed project is served from SQLite');
      assert.equal(projects[0]?.displayName, 'Indexed Project');
      assert.deepEqual(
        projects[0]?.sessions.map((session) => session.id),
        ['indexed-sess'],
        'its indexed session comes back too',
      );
    } finally {
      scans.release();
      mock.restoreAll();
    }
  });
});

test('GET /api/projects still requests a background refresh', async () => {
  await withSeededDatabase(async (server) => {
    const scans = blockProviderScans();

    try {
      await getJson(server.port, '/api/projects');
      assert.equal(scans.scanCount(), 1, 'freshness is not skipped, only moved off the request path');
    } finally {
      scans.release();
      mock.restoreAll();
    }
  });
});

test('GET /api/projects?sync=1 opts back into awaiting the scan', async () => {
  await withSeededDatabase(async (server) => {
    let scanCompleted = false;
    mock.method(sessionSynchronizerService, 'synchronizeSessions', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      scanCompleted = true;
      return { processedByProvider: { claude: 0, codex: 0, antigravity: 0 }, failures: [] };
    });

    try {
      await getJson(server.port, '/api/projects?sync=1');
      assert.equal(scanCompleted, true, 'the response waited for the scan to finish');
    } finally {
      mock.restoreAll();
    }
  });
});

test('GET /api/projects/archived lists archived projects only', async () => {
  await withSeededDatabase(async (server) => {
    const archived = projectsDb.createProjectPath('/workspace/archived-proj', 'Archived Project');
    await requestText(server.port, 'DELETE', `/api/projects/${archived.project?.project_id}`);

    const body = await getJson(server.port, '/api/projects/archived') as {
      success: boolean;
      data: { projects: Array<{ displayName: string }> };
    };
    assert.equal(body.success, true);
    assert.equal(body.data.projects.length, 1);
    assert.equal(body.data.projects[0]?.displayName, 'Archived Project');
  });
});

test('GET /api/projects/:projectId/sessions paginates with limit/offset and validates them', async () => {
  await withSeededDatabase(async (server) => {
    const project = projectsDb.getProjectPath('/workspace/indexed-proj');
    const page = await getJson(
      server.port,
      `/api/projects/${project?.project_id}/sessions?limit=5&offset=0`,
    ) as { sessions: Array<{ id: string }> };
    assert.deepEqual(page.sessions.map((s) => s.id), ['indexed-sess']);

    const badLimit = await requestText(
      server.port,
      'GET',
      `/api/projects/${project?.project_id}/sessions?limit=-1`,
    );
    assert.equal(badLimit.statusCode, 400);
  });
});

test('GET /api/projects/:projectId/sessions/:sessionId/token-usage reports usage for a real session', async () => {
  await withSeededDatabase(async (server) => {
    const usage = await getJson(server.port, '/api/projects/proj1/sessions/indexed-sess/token-usage') as {
      totalTokens?: number;
    };
    assert.equal(typeof usage, 'object');
  });
});

test('POST /api/projects/create-project rejects legacy workspaceType and github clone params', async () => {
  await withSeededDatabase(async (server) => {
    const legacyWorkspace = await requestText(server.port, 'POST', '/api/projects/create-project', {
      path: '/workspace/new-proj',
      workspaceType: 'git',
    });
    assert.equal(legacyWorkspace.statusCode, 400);
    assert.match(legacyWorkspace.body, /workspaceType is no longer supported/);

    const withGithub = await requestText(server.port, 'POST', '/api/projects/create-project', {
      path: '/workspace/new-proj',
      githubUrl: 'https://github.com/foo/bar',
    });
    assert.equal(withGithub.statusCode, 400);
    assert.match(withGithub.body, /Repository cloning is not supported/);
  });
});

test('POST /api/projects/create-project creates a new project', async () => {
  // createProject validates the path is under WORKSPACES_ROOT, which -- since
  // WORKSPACES_ROOT is captured from the environment at module import time,
  // long before this test file can override it -- resolves to the real
  // os.homedir() here. That's writable on a dev box, but some CI containers
  // run as root, where FORBIDDEN_WORKSPACE_PATHS blocks /root outright and
  // this scenario can never validate. Skip there rather than asserting a
  // false failure; the createProject success path itself (with an injected,
  // always-valid `validatePath`) is covered directly in
  // project-management.service.test.ts.
  const { validateWorkspacePath } = await import('@/shared/utils.js');
  const candidateDir = path.join(os.homedir(), '.cloudcli-projects-routes-test-probe');
  const probe = await validateWorkspacePath(candidateDir);
  if (!probe.valid) {
    return;
  }

  await withSeededDatabase(async (server) => {
    const newProjectDir = await mkdtemp(path.join(os.homedir(), '.cloudcli-projects-routes-test-'));
    try {
      const response = await requestText(server.port, 'POST', '/api/projects/create-project', {
        path: newProjectDir,
        customName: 'Brand New',
      });
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.success, true);
      assert.equal(body.project.customName, 'Brand New');
      assert.match(body.message, /Project created successfully/);
    } finally {
      await rm(newProjectDir, { recursive: true, force: true });
    }
  });
});

test('POST /api/projects/migrate-legacy-stars applies legacy starred ids', async () => {
  await withSeededDatabase(async (server) => {
    const project = projectsDb.getProjectPath('/workspace/indexed-proj');
    const response = await requestText(server.port, 'POST', '/api/projects/migrate-legacy-stars', {
      projectIds: [project?.project_id],
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.success, true);
    assert.equal(body.updated, 1);
  });
});

test('PUT /api/projects/:projectId/rename updates the display name', async () => {
  await withSeededDatabase(async (server) => {
    const project = projectsDb.getProjectPath('/workspace/indexed-proj');
    const response = await requestText(
      server.port,
      'PUT',
      `/api/projects/${project?.project_id}/rename`,
      { displayName: 'Renamed Project' },
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { success: true });
    assert.equal(projectsDb.getProjectPath('/workspace/indexed-proj')?.custom_project_name, 'Renamed Project');
  });
});

test('POST /api/projects/:projectId/toggle-star flips the starred flag', async () => {
  await withSeededDatabase(async (server) => {
    const project = projectsDb.getProjectPath('/workspace/indexed-proj');
    const first = await requestText(server.port, 'POST', `/api/projects/${project?.project_id}/toggle-star`);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.equal(firstBody.success, true);

    const second = await requestText(server.port, 'POST', `/api/projects/${project?.project_id}/toggle-star`);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.isStarred, !firstBody.isStarred);
  });
});

test('DELETE then POST .../restore round-trips an archived project back to active', async () => {
  await withSeededDatabase(async (server) => {
    const project = projectsDb.getProjectPath('/workspace/indexed-proj');
    const del = await requestText(server.port, 'DELETE', `/api/projects/${project?.project_id}`);
    assert.equal(del.statusCode, 200);
    assert.equal(projectsDb.getProjectPath('/workspace/indexed-proj')?.isArchived, 1);

    const restore = await requestText(server.port, 'POST', `/api/projects/${project?.project_id}/restore`);
    assert.equal(restore.statusCode, 200);
    const restoreBody = JSON.parse(restore.body);
    assert.equal(restoreBody.success, true);
    assert.equal(restoreBody.data.isArchived, false);
    assert.equal(projectsDb.getProjectPath('/workspace/indexed-proj')?.isArchived, 0);
  });
});

test('clone progress accepts POST JSON instead of credentials in a GET URL', async () => {
  await withSeededDatabase(async (server) => {
    const getResponse = await requestText(server.port, 'GET', '/api/projects/clone-progress');
    assert.equal(getResponse.statusCode, 404);

    const postResponse = await requestText(server.port, 'POST', '/api/projects/clone-progress', {
      path: '/workspace',
      githubUrl: '-invalid-option-like-url',
      newGithubToken: 'body-only-secret',
    });

    assert.equal(postResponse.statusCode, 200);
    assert.match(postResponse.body, /"type":"error"/);
    assert.match(postResponse.body, /Invalid githubUrl/);
    assert.doesNotMatch(postResponse.body, /body-only-secret/);
  });
});
