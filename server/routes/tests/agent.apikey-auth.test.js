import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

// Self-hosted (non-platform) auth path for `POST /api/agent`. This lives in
// its own file so `IS_PLATFORM` (frozen at import time from constants/config)
// resolves to false in this process -- agent.integration.test.js exercises
// the platform-mode path in a separate subprocess.

test('POST /api/agent (self-hosted API key auth) accepts a valid key and rejects a missing/invalid one', async () => {
  process.env.VITE_IS_PLATFORM = 'false';
  process.env.VITE_AUTH_DISABLED = 'true';
  process.env.AGENT_MOCK_PROVIDER = 'true';

  const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-int-apikey-'));
  const dbPath = path.join(tempDir, 'auth.db');
  const projectPath = path.join(tempDir, 'project');
  await mkdir(projectPath, { recursive: true });

  const { closeConnection } = await import('../../modules/database/connection.js');
  const { initializeDatabase } = await import('../../modules/database/init-db.js');
  const { apiKeysDb } = await import('../../modules/database/repositories/api-keys.js');
  const { userDb } = await import('../../modules/database/repositories/users.js');
  const { providerModelsService } = await import(
    '../../modules/providers/services/provider-models.service.js'
  );

  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase();

  const originalGetProviderModels = providerModelsService.getProviderModels;
  providerModelsService.getProviderModels = async () => ({
    models: { OPTIONS: [], DEFAULT: 'mock-model' },
    cache: { status: 'stubbed' },
  });

  const user = userDb.getFirstUser();
  const { apiKey } = apiKeysDb.createApiKey(user.id, 'test-key');

  const { default: agentRouter } = await import('../agent.js');
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/agent`;

  try {
    const noKey = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, message: 'hi', provider: 'mock', stream: false }),
    });
    assert.equal(noKey.status, 401);
    assert.match((await noKey.json()).error, /API key required/);

    const badKey = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'not-a-real-key' },
      body: JSON.stringify({ projectPath, message: 'hi', provider: 'mock', stream: false }),
    });
    assert.equal(badKey.status, 401);
    assert.match((await badKey.json()).error, /Invalid or inactive API key/);

    const goodKey = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ projectPath, message: 'hi', provider: 'mock', stream: false }),
    });
    assert.equal(goodKey.status, 200);
    const body = await goodKey.json();
    assert.equal(body.success, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    providerModelsService.getProviderModels = originalGetProviderModels;
    closeConnection();
    await rm(tempDir, { recursive: true, force: true });
  }
});
