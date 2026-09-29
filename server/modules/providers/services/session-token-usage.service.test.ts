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

// Same class as #181: `.` is a legal body character, so an all-dots id passed
// SESSION_ID_PATTERN. That is not merely theoretical here — the Codex finder
// matches on `entry.name.includes(sessionId)`, and every `*.jsonl` name
// contains a `.`, so `.` would match the first file walked and report a
// stranger's token usage. This asserts the guard runs before that walk.
test('getSessionTokenUsage rejects reserved dot-only ids before they can match an unrelated Codex file', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-test-'));
  try {
    await fsp.writeFile(
      path.join(root, 'rollout-2026-05-17-someone-elses-session.jsonl'),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 4242 }, model_context_window: 128000 },
        },
      }) + '\n',
    );

    for (const reserved of ['.', '..', '...']) {
      const result = await getSessionTokenUsage(reserved, {
        getSessionById: () => {
          throw new Error('getSessionById should not be called for reserved ids');
        },
        getClaudeUsage: async () => {
          throw new Error('claude path should not be reached');
        },
        resolveCodexSessionsDir: () => root,
      });

      assert.equal(result.unsupported, true, reserved);
      // Without the guard this is where the unrelated file's 4242 leaks through.
      assert.equal(result.used, 0, reserved);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('getSessionTokenUsage still accepts ids that merely contain dots', async () => {
  // The guard is narrow by design — dotted ids are legitimate and must route
  // normally.
  const result = await getSessionTokenUsage('session.v2.0', {
    getSessionById: () => ({ provider: 'claude' }),
    getClaudeUsage: async () => ({
      used: 7,
      total: 160000,
      breakdown: { input: 7, cacheCreation: 0, cacheRead: 0 },
    }),
    resolveCodexSessionsDir: () => '/never-touched',
  });

  assert.equal(result.unsupported, undefined);
  assert.equal(result.used, 7);
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

test('getSessionTokenUsage uses the DB-indexed jsonl_path directly, without walking the sessions dir', async () => {
  const sessionId = 'codex-session-indexed';
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-test-'));
  try {
    const filePath = path.join(root, `rollout-${sessionId}.jsonl`);
    await fsp.writeFile(filePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 321 }, model_context_window: 128000 },
        },
      }),
    ].join('\n') + '\n');

    const result = await getSessionTokenUsage(sessionId, {
      getSessionById: () => ({ provider: 'codex', jsonl_path: filePath }),
      getClaudeUsage: async () => {
        throw new Error('claude path should not be reached for codex sessions');
      },
      // The directory walk must never be reached when jsonl_path already
      // points at a real file -- resolving it would throw.
      resolveCodexSessionsDir: () => {
        throw new Error('resolveCodexSessionsDir should not be called when jsonl_path is already valid');
      },
    });

    assert.equal(result.used, 321);
    assert.equal(result.total, 128000);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('getSessionTokenUsage falls back to the directory walk when jsonl_path points at a file that no longer exists', async () => {
  const sessionId = 'codex-session-missing-path';
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-test-'));
  try {
    const filePath = path.join(root, `rollout-${sessionId}.jsonl`);
    await fsp.writeFile(filePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 555 }, model_context_window: 128000 },
        },
      }),
    ].join('\n') + '\n');

    const result = await getSessionTokenUsage(sessionId, {
      getSessionById: () => ({ provider: 'codex', jsonl_path: path.join(root, 'no-longer-there.jsonl') }),
      getClaudeUsage: async () => {
        throw new Error('claude path should not be reached for codex sessions');
      },
      resolveCodexSessionsDir: () => root,
    });

    assert.equal(result.used, 555);
    assert.equal(result.total, 128000);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// `fileExists` (session-token-usage.service.ts) only checks that jsonl_path
// resolves to *some* readable file -- it has no way to confirm the file still
// belongs to this session. Documents the known, accepted limitation: a
// present-but-wrong jsonl_path (e.g. a row whose session was merged/renamed
// on disk without the DB catching up) is trusted rather than falling back to
// the directory walk, unlike a genuinely missing path.
test('getSessionTokenUsage trusts an existing jsonl_path even if it belongs to a different session (known limitation)', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-test-'));
  try {
    const wrongSessionPath = path.join(root, 'rollout-some-other-session.jsonl');
    await fsp.writeFile(wrongSessionPath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 4242 }, model_context_window: 128000 },
        },
      }),
    ].join('\n') + '\n');

    const result = await getSessionTokenUsage('codex-session-real-id', {
      getSessionById: () => ({ provider: 'codex', jsonl_path: wrongSessionPath }),
      getClaudeUsage: async () => {
        throw new Error('claude path should not be reached for codex sessions');
      },
      resolveCodexSessionsDir: () => {
        throw new Error('resolveCodexSessionsDir should not be called: an existing path is trusted as-is');
      },
    });

    // Documents current behavior rather than asserting it is correct: the
    // wrong file's usage leaks through because existence, not identity, is
    // what's checked.
    assert.equal(result.used, 4242);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('getSessionTokenUsage reads a large Codex transcript from the tail, without loading it whole', async () => {
  const sessionId = 'codex-session-tail-scan';
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-test-'));
  try {
    const filePath = path.join(root, `rollout-${sessionId}.jsonl`);
    // Pad the file well past the 256 KiB tail window with lines that don't
    // parse as token_count events, then put the real event at the very end.
    const filler = `${JSON.stringify({ type: 'event_msg', payload: { type: 'noise', text: 'x'.repeat(500) } })}\n`;
    const paddingLines = Math.ceil((512 * 1024) / filler.length);
    const parts = new Array(paddingLines).fill(filler);
    parts.push(`${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 9001 }, model_context_window: 128000 },
      },
    })}\n`);
    await fsp.writeFile(filePath, parts.join(''));

    const result = await getSessionTokenUsage(sessionId, {
      getSessionById: () => ({ provider: 'codex', jsonl_path: filePath }),
      getClaudeUsage: async () => {
        throw new Error('claude path should not be reached for codex sessions');
      },
      resolveCodexSessionsDir: () => {
        throw new Error('resolveCodexSessionsDir should not be called');
      },
    });

    assert.equal(result.used, 9001);
    assert.equal(result.total, 128000);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('getSessionTokenUsage falls back to a full scan when the tail window has no token_count event', async () => {
  const sessionId = 'codex-session-full-scan-fallback';
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-test-'));
  try {
    const filePath = path.join(root, `rollout-${sessionId}.jsonl`);
    // The only token_count event is the very first line; everything after it
    // is >256 KiB of noise, so the tail read alone finds nothing and the
    // function must fall through to the full `streamJsonlEntries` scan.
    const tokenCountLine = `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 777 }, model_context_window: 128000 },
      },
    })}\n`;
    const filler = `${JSON.stringify({ type: 'event_msg', payload: { type: 'noise', text: 'x'.repeat(500) } })}\n`;
    const paddingLines = Math.ceil((512 * 1024) / filler.length);
    const parts = [tokenCountLine, ...new Array(paddingLines).fill(filler)];
    await fsp.writeFile(filePath, parts.join(''));

    const { size } = await fsp.stat(filePath);
    assert.ok(size > 256 * 1024, 'fixture must exceed the tail window');

    const result = await getSessionTokenUsage(sessionId, {
      getSessionById: () => ({ provider: 'codex', jsonl_path: filePath }),
      getClaudeUsage: async () => {
        throw new Error('claude path should not be reached for codex sessions');
      },
      resolveCodexSessionsDir: () => {
        throw new Error('resolveCodexSessionsDir should not be called');
      },
    });

    assert.equal(result.used, 777);
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
