import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { featureUsageDb } from '@/modules/database/repositories/feature-usage.db.js';

import usageRoutes from '../usage.js';

type PostResult = { status: number; body: { enabled?: boolean; recorded?: number } };

async function withUsageServer(
  runTest: (post: (payload: unknown) => Promise<PostResult>) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousEnabled = process.env.FEATURE_USAGE_ENABLED;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'usage-route-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  delete process.env.FEATURE_USAGE_ENABLED;
  await initializeDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/usage', usageRoutes);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const post = async (payload: unknown): Promise<PostResult> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json()) as PostResult['body'] };
  };

  try {
    await runTest(post);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousEnabled === undefined) delete process.env.FEATURE_USAGE_ENABLED;
    else process.env.FEATURE_USAGE_ENABLED = previousEnabled;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const countFor = (key: string) =>
  featureUsageDb.listUsage().find((entry) => entry.featureKey === key)?.useCount;

test('POST /api/usage records a batch and reports recording as enabled', async () => {
  await withUsageServer(async (post) => {
    const result = await post({ keys: ['chat.send', 'chat.send', 'git.commit'] });

    assert.equal(result.status, 200);
    assert.equal(result.body.enabled, true);
    assert.equal(result.body.recorded, 3);
    assert.equal(countFor('chat.send'), 2);
    assert.equal(countFor('git.commit'), 1);
  });
});

test('POST /api/usage answers 200 for malformed bodies instead of failing the client', async () => {
  await withUsageServer(async (post) => {
    for (const payload of [{}, { keys: 'chat.send' }, { keys: null }, []]) {
      const result = await post(payload);
      assert.equal(result.status, 200, JSON.stringify(payload));
      assert.equal(result.body.recorded, 0, JSON.stringify(payload));
    }
  });
});

test('POST /api/usage reports enabled:false and stores nothing when switched off', async () => {
  await withUsageServer(async (post) => {
    process.env.FEATURE_USAGE_ENABLED = 'false';

    const result = await post({ keys: ['chat.send'] });

    // The client latches off recording when it sees this, so the off switch
    // stops the traffic and not just the writes.
    assert.equal(result.body.enabled, false);
    assert.equal(result.body.recorded, 0);
    assert.equal(countFor('chat.send'), 0);
  });
});
