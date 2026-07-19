import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getSessionTokenUsage } from '@/modules/providers/services/session-token-usage.service.js';

// Tests cover the dispatcher's per-provider routing without touching the
// real DB or filesystem (except for the Codex finder test which needs a
// physical .jsonl file to walk).

test('getSessionTokenUsage returns the Claude payload when the session is a claude row', async () => {
  const result = await getSessionTokenUsage('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
    getSessionById: () => ({ provider: 'claude' }),
    getClaudeUsage: async () => ({
      used: 1234,
      total: 200000,
      breakdown: { input: 1000, cacheCreation: 200, cacheRead: 34 },
    }),
    resolveCodexSessionsDir: () => '/never-touched',
  });

  assert.deepEqual(result, {
    used: 1234,
    total: 200000,
    breakdown: { input: 1000, cacheCreation: 200, cacheRead: 34 },
  });
});

test('getSessionTokenUsage falls through to Claude when the session is unknown to the DB', async () => {
  // Unknown rows default to Claude because that's the legacy behavior the
  // frontend depends on (query-param-less requests).
  let claudeCalled = false;
  const result = await getSessionTokenUsage('99999999-9999-9999-9999-999999999999', {
    getSessionById: () => null,
    getClaudeUsage: async () => {
      claudeCalled = true;
      return { used: 0, total: 160000, breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 } };
    },
    resolveCodexSessionsDir: () => '/never-touched',
  });

  assert.equal(claudeCalled, true);
  assert.equal(result.total, 160000);
});

test('getSessionTokenUsage rejects unsafe session ids with an unsupported response', async () => {
  // Defense-in-depth: the route only ever exposes this through a URL param,
  // but we keep the legacy validation to fail closed if a caller passes
  // shell-meaningful characters.
  const result = await getSessionTokenUsage('../../etc/passwd', {
    getSessionById: () => {
      throw new Error('getSessionById should not be called for unsafe ids');
    },
    getClaudeUsage: async () => {
      throw new Error('claude path should not be reached');
    },
    resolveCodexSessionsDir: () => '/never-touched',
  });

  assert.equal(result.unsupported, true);
});

test('getSessionTokenUsage walks the Codex sessions dir to find the JSONL file and parses the latest token_count event', async () => {
  const sessionId = 'codex-session-77';
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-test-'));
  try {
    const nestedDir = path.join(root, '2026', '05', '17');
    await fsp.mkdir(nestedDir, { recursive: true });
    const filePath = path.join(nestedDir, `rollout-2026-05-17-${sessionId}.jsonl`);
    await fsp.writeFile(filePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 100 }, model_context_window: 128000 },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 500 }, model_context_window: 128000 },
        },
      }),
    ].join('\n') + '\n');

    const result = await getSessionTokenUsage(sessionId, {
      getSessionById: () => ({ provider: 'codex' }),
      getClaudeUsage: async () => {
        throw new Error('claude path should not be reached for codex sessions');
      },
      resolveCodexSessionsDir: () => root,
    });

    assert.equal(result.used, 500);
    assert.equal(result.total, 128000);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('getSessionTokenUsage returns the Codex default context window when the JSONL file is missing', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-test-'));
  try {
    const result = await getSessionTokenUsage('codex-missing', {
      getSessionById: () => ({ provider: 'codex' }),
      getClaudeUsage: async () => {
        throw new Error('claude path should not be reached for codex sessions');
      },
      resolveCodexSessionsDir: () => root,
    });

    assert.equal(result.used, 0);
    assert.equal(result.total, 200000);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
