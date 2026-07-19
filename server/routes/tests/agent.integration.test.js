import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

// End-to-end coverage for `POST /api/agent`: the non-streaming JSON assembly
// and the streaming SSE path, driven by the env-gated in-process `mock`
// provider (see mock-agent-provider.js) so no real CLI/SDK, network, or auth is
// required. Guards the #96/#123 regression where the non-streaming reply
// returned empty `messages`/`tokens`.
//
// The auth + config flags (VITE_IS_PLATFORM, AGENT_MOCK_PROVIDER) are read from
// the environment, and IS_PLATFORM is frozen at import time — so every
// config-dependent module is loaded via dynamic import AFTER the env is set.

/**
 * Boot an isolated agent server (fresh sqlite DB + seeded default user) with the
 * mock provider enabled, run `fn` against it, then tear everything down.
 */
async function withAgentServer(fn) {
  process.env.VITE_IS_PLATFORM = 'true'; // trust req.user = getFirstUser()
  process.env.VITE_AUTH_DISABLED = 'true'; // seed the default user on init
  process.env.AGENT_MOCK_PROVIDER = 'true'; // allow provider: 'mock'

  const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-int-'));
  const dbPath = path.join(tempDir, 'auth.db');
  const projectPath = path.join(tempDir, 'project');
  await mkdir(projectPath, { recursive: true });

  const { closeConnection } = await import('../../modules/database/connection.js');
  const { initializeDatabase } = await import('../../modules/database/init-db.js');
  const { providerModelsService } = await import(
    '../../modules/providers/services/provider-models.service.js'
  );

  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase();

  // Keep the run hermetic: agent.js fetches codex models unconditionally
  // before dispatch. Stub it so the test never touches a models cache or CLI.
  const originalGetProviderModels = providerModelsService.getProviderModels;
  providerModelsService.getProviderModels = async () => ({
    models: { OPTIONS: [], DEFAULT: 'mock-model' },
    cache: { status: 'stubbed' },
  });

  const { default: agentRouter } = await import('../agent.js');
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/agent`;

  try {
    await fn({ baseUrl, projectPath });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    providerModelsService.getProviderModels = originalGetProviderModels;
    closeConnection();
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Parse an SSE response body into the list of decoded `data:` frame objects. */
function parseSseFrames(body) {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

test('POST /api/agent (stream:false) returns assistant messages and token totals', async () => {
  const { MOCK_ASSISTANT_TEXT, MOCK_ASSISTANT_FRAME_COUNT, MOCK_TOKEN_BUDGET } = await import(
    '../mock-agent-provider.js'
  );

  await withAgentServer(async ({ baseUrl, projectPath }) => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, message: 'do the thing', provider: 'mock', stream: false }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.success, true);
    assert.equal(typeof body.sessionId, 'string');
    assert.ok(body.sessionId.length > 0, 'sessionId should be populated');

    // Only the two assistant `kind:'text'` frames survive filtering — the
    // `thinking` status frame and the initial session status are excluded.
    assert.equal(body.messages.length, MOCK_ASSISTANT_FRAME_COUNT);
    assert.ok(
      !body.messages.some((m) => m.kind === 'status'),
      'status/thinking frames must be filtered out of messages',
    );
    for (const msg of body.messages) {
      assert.equal(msg.kind, 'text');
      assert.equal(msg.role, 'assistant');
    }
    assert.equal(body.messages.map((m) => m.content).join(''), MOCK_ASSISTANT_TEXT);

    // Token summary comes from the cumulative token_budget frame.
    assert.equal(body.tokens.inputTokens, MOCK_TOKEN_BUDGET.inputTokens);
    assert.equal(body.tokens.outputTokens, MOCK_TOKEN_BUDGET.outputTokens);
    assert.equal(
      body.tokens.totalTokens,
      MOCK_TOKEN_BUDGET.inputTokens + MOCK_TOKEN_BUDGET.outputTokens,
    );
    assert.equal(body.projectPath, projectPath);
  });
});

test('POST /api/agent (stream:true) emits SSE frames terminated by done', async () => {
  const { MOCK_ASSISTANT_TEXT, MOCK_ASSISTANT_FRAME_COUNT } = await import('../mock-agent-provider.js');

  await withAgentServer(async ({ baseUrl, projectPath }) => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, message: 'do the thing', provider: 'mock', stream: true }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const frames = parseSseFrames(await response.text());

    // The initial status frame echoes the resolved project path.
    const statusFrame = frames.find((f) => f.type === 'status');
    assert.ok(statusFrame, 'expected an initial status frame');
    assert.equal(statusFrame.projectPath, projectPath);

    // The session id is announced as its own frame on the streaming path.
    const sessionFrame = frames.find((f) => f.type === 'session-id');
    assert.ok(sessionFrame, 'expected a session-id frame');
    assert.ok(typeof sessionFrame.sessionId === 'string' && sessionFrame.sessionId.length > 0);

    // Assistant prose arrives as object frames (SSE is object-accepting).
    const textFrames = frames.filter((f) => f.kind === 'text' && f.role === 'assistant');
    assert.equal(textFrames.length, MOCK_ASSISTANT_FRAME_COUNT);
    assert.equal(textFrames.map((f) => f.content).join(''), MOCK_ASSISTANT_TEXT);

    const tokenFrame = frames.find((f) => f.kind === 'status' && f.text === 'token_budget');
    assert.ok(tokenFrame, 'expected a token_budget status frame');

    // The stream is terminated by the sentinel done frame.
    assert.deepEqual(frames.at(-1), { type: 'done' });
  });
});

test('POST /api/agent rejects the mock provider when AGENT_MOCK_PROVIDER is off', async () => {
  await withAgentServer(async ({ baseUrl, projectPath }) => {
    const previous = process.env.AGENT_MOCK_PROVIDER;
    process.env.AGENT_MOCK_PROVIDER = 'false';
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, message: 'do the thing', provider: 'mock', stream: false }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error, /provider must be/);
    } finally {
      process.env.AGENT_MOCK_PROVIDER = previous;
    }
  });
});

test('POST /api/agent validates required inputs', async () => {
  await withAgentServer(async ({ baseUrl, projectPath }) => {
    // Missing message.
    const noMessage = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, provider: 'mock', stream: false }),
    });
    assert.equal(noMessage.status, 400);

    // Missing both githubUrl and projectPath.
    const noTarget = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', provider: 'mock', stream: false }),
    });
    assert.equal(noTarget.status, 400);

    // Unknown provider.
    const badProvider = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, message: 'hi', provider: 'bogus', stream: false }),
    });
    assert.equal(badProvider.status, 400);
  });
});
