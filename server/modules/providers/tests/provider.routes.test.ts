import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import providerRouter from '../provider.routes.js';
import { providerAuthService } from '../services/provider-auth.service.js';
import { providerCapabilitiesService } from '../services/provider-capabilities.service.js';
import { providerMcpService } from '../services/mcp.service.js';
import { providerModelsService } from '../services/provider-models.service.js';
import { providerSkillsService } from '../services/skills.service.js';
import { sessionConversationsSearchService } from '../services/session-conversations-search.service.js';
import { sessionsService } from '../services/sessions.service.js';
import { AppError } from '../../../shared/utils.js';

async function readJson(res: Response): Promise<any> {
  return res.json();
}


// Route-level coverage for provider.routes.ts: every service it wires to is a
// plain exported object, so each test stubs the specific methods it needs and
// restores them afterward. Real behaviour under test is the HTTP wiring --
// param parsing, status codes, response envelopes, and error propagation --
// not the services themselves (each has its own dedicated test file).

function withServer(fn: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api/providers', providerRouter);
  // Mirrors server/index.js's global AppError -> JSON error middleware.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  const server = http.createServer(app);
  return new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      fn(`http://127.0.0.1:${port}/api/providers`)
        .then(resolve, reject)
        .finally(() => server.close());
    });
  });
}

function patch<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]): () => void {
  const original = obj[key];
  obj[key] = value;
  return () => {
    obj[key] = original;
  };
}

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------

test('GET /:provider/auth/status returns the service result wrapped in a success envelope', async () => {
  const restore = patch(providerAuthService, 'getProviderAuthStatus', async (provider: string) => {
    assert.equal(provider, 'claude');
    return { installed: true, authenticated: true } as any;
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/auth/status`);
      assert.equal(res.status, 200);
      assert.deepEqual(await readJson(res), { success: true, data: { installed: true, authenticated: true } });
    });
  } finally {
    restore();
  }
});

test('GET /:provider/auth/status 400s for an unsupported provider', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/bogus/auth/status`);
    assert.equal(res.status, 400);
    const body = await readJson(res);
    assert.equal(body.error.code, 'UNSUPPORTED_PROVIDER');
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

test('GET /:provider/models forwards bypassCache and returns models + cache', async () => {
  let seenBypassCache: unknown;
  const restore = patch(providerModelsService, 'getProviderModels', async (provider: string, opts: any) => {
    seenBypassCache = opts?.bypassCache;
    return { models: { OPTIONS: [], DEFAULT: 'default' }, cache: { source: 'fresh' } } as any;
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/codex/models?bypassCache=true`);
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.equal(body.data.provider, 'codex');
      assert.equal(seenBypassCache, true);
    });
  } finally {
    restore();
  }
});

test('POST /:provider/sessions/:sessionId/active-model rejects an invalid sessionId before calling the service', async () => {
  let called = false;
  const restore = patch(providerModelsService, 'changeActiveModel', async () => {
    called = true;
    return {} as any;
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/sessions/bad%2Fid/active-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet' }),
      });
      assert.equal(res.status, 400);
      assert.equal(called, false);
    });
  } finally {
    restore();
  }
});

test('POST /:provider/sessions/:sessionId/active-model calls the service with parsed payload', async () => {
  let seenArgs: unknown;
  const restore = patch(providerModelsService, 'changeActiveModel', async (provider: string, args: any) => {
    seenArgs = { provider, ...args };
    return { model: 'sonnet' } as any;
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/sessions/abc123/active-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(seenArgs, { provider: 'claude', model: 'sonnet', sessionId: 'abc123' });
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Skills (listing thoroughly; install/remove kept minimal per task brief)
// ---------------------------------------------------------------------------

test('GET /:provider/skills lists skills and forwards an optional workspacePath', async () => {
  let seenOptions: unknown;
  const restore = patch(providerSkillsService, 'listProviderSkills', async (provider: string, options: any) => {
    seenOptions = options;
    return [{ name: 'a-skill' }] as any;
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/skills?workspacePath=%2Ftmp%2Fws`);
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.equal(body.data.provider, 'claude');
      assert.deepEqual(body.data.skills, [{ name: 'a-skill' }]);
      assert.deepEqual(seenOptions, { workspacePath: '/tmp/ws' });
    });
  } finally {
    restore();
  }
});

test('GET /:provider/skills omits workspacePath when not provided', async () => {
  const restore = patch(providerSkillsService, 'listProviderSkills', async (_provider: string, options: any) => {
    assert.deepEqual(options, { workspacePath: undefined });
    return [];
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/skills`);
      assert.equal(res.status, 200);
    });
  } finally {
    restore();
  }
});

test('POST /:provider/skills (install) reaches the service with the parsed entry', async () => {
  const restore = patch(providerSkillsService, 'addProviderSkills', async (provider: string, input: any) => {
    assert.equal(provider, 'claude');
    assert.equal(input.entries[0].directoryName, 'new-skill');
    return [{ name: 'new-skill' }] as any;
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# skill', directoryName: 'new-skill' }),
      });
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.deepEqual(body.data.skills, [{ name: 'new-skill' }]);
    });
  } finally {
    restore();
  }
});

test('DELETE /:provider/skills/:directoryName removes a skill', async () => {
  const restore = patch(providerSkillsService, 'removeProviderSkill', async (provider: string, input: any) => {
    assert.equal(provider, 'claude');
    assert.equal(input.directoryName, 'my-skill');
    return { removed: true, provider: 'claude', directoryName: 'my-skill' };
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/skills/my-skill`, { method: 'DELETE' });
      assert.equal(res.status, 200);
      assert.deepEqual((await readJson(res)).data, { removed: true, provider: 'claude', directoryName: 'my-skill' });
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test('GET /:provider/mcp/servers without a scope returns grouped scopes', async () => {
  const restore = patch(providerMcpService, 'listProviderMcpServers', async () => ({
    user: [], project: [], local: [],
  }) as any);
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/mcp/servers`);
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.equal(body.data.provider, 'claude');
      assert.deepEqual(body.data.scopes, { user: [], project: [], local: [] });
    });
  } finally {
    restore();
  }
});

test('GET /:provider/mcp/servers with a scope returns a flat list for that scope', async () => {
  let seenScope: unknown;
  const restore = patch(providerMcpService, 'listProviderMcpServersForScope', async (_p: string, scope: string) => {
    seenScope = scope;
    return [{ name: 'srv1' }] as any;
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/mcp/servers?scope=user`);
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.equal(body.data.scope, 'user');
      assert.deepEqual(body.data.servers, [{ name: 'srv1' }]);
      assert.equal(seenScope, 'user');
    });
  } finally {
    restore();
  }
});

test('POST /:provider/mcp/servers upserts and returns 201', async () => {
  const restore = patch(providerMcpService, 'upsertProviderMcpServer', async () => ({ name: 'srv1' }) as any);
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/mcp/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'srv1', scope: 'user', transport: 'stdio', command: 'foo' }),
      });
      assert.equal(res.status, 201);
      assert.deepEqual((await readJson(res)).data, { server: { name: 'srv1' } });
    });
  } finally {
    restore();
  }
});

test('DELETE /:provider/mcp/servers/:name removes a server with scope + workspacePath forwarded', async () => {
  let seenInput: unknown;
  const restore = patch(providerMcpService, 'removeProviderMcpServer', async (_p: string, input: any) => {
    seenInput = input;
    return { removed: true, provider: 'claude', name: 'srv1', scope: 'user' };
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/claude/mcp/servers/srv1?scope=user&workspacePath=%2Ftmp`, {
        method: 'DELETE',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(seenInput, { name: 'srv1', scope: 'user', workspacePath: '/tmp' });
    });
  } finally {
    restore();
  }
});

test('POST /mcp/servers/global rejects a "local" scope with 400', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/mcp/servers/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'srv1', scope: 'local', transport: 'stdio', command: 'foo' }),
    });
    assert.equal(res.status, 400);
    const body = await readJson(res);
    assert.equal(body.error.code, 'INVALID_GLOBAL_MCP_SCOPE');
  });
});

test('POST /mcp/servers/global normalizes a missing/other scope to "project" and forwards "user" as-is', async () => {
  const seenScopes: unknown[] = [];
  const restore = patch(providerMcpService, 'addMcpServerToAllProviders', async (input: any) => {
    seenScopes.push(input.scope);
    return [];
  });
  try {
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/mcp/servers/global`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'srv1', transport: 'stdio', command: 'foo' }),
      });
      await fetch(`${baseUrl}/mcp/servers/global`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'srv2', scope: 'user', transport: 'stdio', command: 'foo' }),
      });
    });
    assert.deepEqual(seenScopes, ['project', 'user']);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

test('GET /capabilities lists all providers', async () => {
  const restore = patch(providerCapabilitiesService, 'listAllProviderCapabilities', () => [{ provider: 'claude' }] as any);
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/capabilities`);
      assert.equal(res.status, 200);
      assert.deepEqual((await readJson(res)).data, { providers: [{ provider: 'claude' }] });
    });
  } finally {
    restore();
  }
});

test('GET /:provider/capabilities returns one provider', async () => {
  const restore = patch(providerCapabilitiesService, 'getProviderCapabilities', (provider: string) => ({ provider }) as any);
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/codex/capabilities`);
      assert.equal(res.status, 200);
      assert.deepEqual((await readJson(res)).data, { provider: 'codex' });
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('POST /sessions creates an app session, defaulting projectPath to ""', async () => {
  let seenArgs: unknown;
  const restore = patch(sessionsService, 'createAppSession', (provider: string, projectPath: string) => {
    seenArgs = { provider, projectPath };
    return { sessionId: 'new-session' } as any;
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'claude' }),
      });
      assert.equal(res.status, 201);
      assert.deepEqual(seenArgs, { provider: 'claude', projectPath: '' });
    });
  } finally {
    restore();
  }
});

test('GET /sessions/running and /sessions/archived list from the service', async () => {
  const restoreRunning = patch(sessionsService, 'listRunningSessions', () => [{ sessionId: 'r1' }] as any);
  const restoreArchived = patch(sessionsService, 'listArchivedSessions', () => [{ sessionId: 'a1' }] as any);
  try {
    await withServer(async (baseUrl) => {
      const running = await fetch(`${baseUrl}/sessions/running`);
      assert.deepEqual((await readJson(running)).data, { sessions: [{ sessionId: 'r1' }] });

      const archived = await fetch(`${baseUrl}/sessions/archived`);
      assert.deepEqual((await readJson(archived)).data, { sessions: [{ sessionId: 'a1' }] });
    });
  } finally {
    restoreRunning();
    restoreArchived();
  }
});

test('GET /sessions/archivable-count and POST /sessions/archive-by-age are not shadowed by :sessionId', async () => {
  const restoreCount = patch(sessionsService, 'countArchivableSessionsOlderThan', (days: number) => ({ archivableCount: days }));
  const restoreBulk = patch(sessionsService, 'bulkArchiveSessionsOlderThan', (days: number) => ({ archived: days }) as any);
  try {
    await withServer(async (baseUrl) => {
      const count = await fetch(`${baseUrl}/sessions/archivable-count?days=7`);
      assert.deepEqual((await readJson(count)).data, { archivableCount: 7 });

      const bulk = await fetch(`${baseUrl}/sessions/archive-by-age`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 30 }),
      });
      assert.deepEqual((await readJson(bulk)).data, { archived: 30 });
    });
  } finally {
    restoreCount();
    restoreBulk();
  }
});

test('GET /sessions/:sessionId resolves a session by id', async () => {
  const restore = patch(sessionsService, 'getSessionDetailsById', (sessionId: string) => ({ sessionId, provider: 'claude' }) as any);
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/sessions/abc123`);
      assert.equal(res.status, 200);
      assert.deepEqual((await readJson(res)).data, { sessionId: 'abc123', provider: 'claude' });
    });
  } finally {
    restore();
  }
});

test('DELETE /sessions/:sessionId derives deletedFromDisk from force when not explicit', async () => {
  let seenOptions: unknown;
  const restore = patch(sessionsService, 'deleteOrArchiveSessionById', async (sessionId: string, options: any) => {
    seenOptions = { sessionId, ...options };
    return { sessionId, action: 'archived', deletedFromDisk: false } as any;
  });
  try {
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/sessions/abc123?force=true`, { method: 'DELETE' });
      assert.deepEqual(seenOptions, { sessionId: 'abc123', force: true, deletedFromDisk: true });
    });
  } finally {
    restore();
  }
});

test('POST /sessions/:sessionId/restore restores a session', async () => {
  const restore = patch(sessionsService, 'restoreSessionById', (sessionId: string) => ({ sessionId, isArchived: false }) as any);
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/sessions/abc123/restore`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.deepEqual((await readJson(res)).data, { sessionId: 'abc123', isArchived: false });
    });
  } finally {
    restore();
  }
});

test('PUT /sessions/:sessionId renames a session', async () => {
  const restore = patch(sessionsService, 'renameSessionById', (sessionId: string, summary: string) => ({ sessionId, summary }));
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/sessions/abc123`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: 'New title' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual((await readJson(res)).data, { sessionId: 'abc123', summary: 'New title' });
    });
  } finally {
    restore();
  }
});

test('GET /sessions/:sessionId/messages parses limit/offset and rejects invalid values', async () => {
  let seenOptions: unknown;
  const restore = patch(sessionsService, 'fetchHistory', async (sessionId: string, options: any) => {
    seenOptions = { sessionId, ...options };
    return { messages: [], total: 0, hasMore: false, offset: 0, limit: 0 } as any;
  });
  try {
    await withServer(async (baseUrl) => {
      const ok = await fetch(`${baseUrl}/sessions/abc123/messages?limit=10&offset=5`);
      assert.equal(ok.status, 200);
      assert.deepEqual(seenOptions, { sessionId: 'abc123', limit: 10, offset: 5 });

      const badLimit = await fetch(`${baseUrl}/sessions/abc123/messages?limit=-1`);
      assert.equal(badLimit.status, 400);

      const badOffset = await fetch(`${baseUrl}/sessions/abc123/messages?offset=notanumber`);
      assert.equal(badOffset.status, 400);
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Search (SSE)
// ---------------------------------------------------------------------------

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = body.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const eventLine = lines.find((l) => l.startsWith('event: '));
    const dataLine = lines.find((l) => l.startsWith('data: '));
    if (eventLine && dataLine) {
      events.push({ event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) });
    }
  }
  return events;
}

test('GET /search/sessions streams progress/result/done SSE events', async () => {
  const restore = patch(sessionConversationsSearchService, 'search', async ({ onProgress }: any) => {
    onProgress({ projectResult: null, totalMatches: 0, scannedProjects: 1, totalProjects: 2 });
    onProgress({ projectResult: { projectPath: '/p' }, totalMatches: 1, scannedProjects: 2, totalProjects: 2 });
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/search/sessions?q=hello`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const events = parseSseEvents(await res.text());
      assert.equal(events[0].event, 'progress');
      assert.equal(events[1].event, 'result');
      assert.equal(events.at(-1)?.event, 'done');
    });
  } finally {
    restore();
  }
});

test('GET /search/sessions rejects a too-short query before invoking the service', async () => {
  let called = false;
  const restore = patch(sessionConversationsSearchService, 'search', async () => {
    called = true;
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/search/sessions?q=a`);
      assert.equal(res.status, 400);
      assert.equal(called, false);
    });
  } finally {
    restore();
  }
});

test('GET /search/sessions streams an error event when the service throws', async () => {
  const restore = patch(sessionConversationsSearchService, 'search', async () => {
    throw new Error('boom');
  });
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/search/sessions?q=hello`);
      assert.equal(res.status, 200);
      const events = parseSseEvents(await res.text());
      assert.equal(events[0].event, 'error');
      assert.deepEqual(events[0].data, { error: 'Search failed' });
    });
  } finally {
    restore();
  }
});
