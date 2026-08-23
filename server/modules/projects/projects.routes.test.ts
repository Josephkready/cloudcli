import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
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
