import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getClaudeSessionTokenUsage } from '@/modules/providers/list/claude/claude-token-usage.provider.js';

async function createSandboxJsonl(sessionId: string, lines: string[]): Promise<{
  filePath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-token-usage-test-'));
  const projectDir = path.join(root, '.claude', 'projects', '-home-jkready');
  await fsp.mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await fsp.writeFile(filePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  return {
    filePath,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

test('getClaudeSessionTokenUsage returns the latest assistant usage record from the JSONL file', async () => {
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const { filePath, cleanup } = await createSandboxJsonl(sessionId, [
    JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
        },
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      },
    }),
  ]);

  try {
    const result = await getClaudeSessionTokenUsage(sessionId, {
      getSessionById: () => ({ jsonl_path: filePath, project_path: '/home/jkready' }),
      resolveJsonlPath: async () => filePath,
      readContextWindowOverride: () => null,
    });

    assert.deepEqual(result, {
      used: 600,
      total: 160000,
      breakdown: { input: 100, cacheCreation: 200, cacheRead: 300 },
    });
  } finally {
    await cleanup();
  }
});

test('getClaudeSessionTokenUsage returns an empty token-usage shape when the JSONL has no assistant usage records', async () => {
  // Empty case: a Claude session that has been opened but never received an
  // assistant reply with usage metadata. The frontend should still render a
  // valid (zero) token budget so we return the canonical shape instead of
  // surfacing the legacy 404.
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const { filePath, cleanup } = await createSandboxJsonl(sessionId, [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
  ]);

  try {
    const result = await getClaudeSessionTokenUsage(sessionId, {
      getSessionById: () => ({ jsonl_path: filePath, project_path: '/home/jkready' }),
      resolveJsonlPath: async () => filePath,
      readContextWindowOverride: () => null,
    });

    assert.deepEqual(result, {
      used: 0,
      total: 160000,
      breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
    });
  } finally {
    await cleanup();
  }
});

test('getClaudeSessionTokenUsage returns an empty token-usage shape when the session has no JSONL file on disk', async () => {
  const sessionId = '22222222-3333-4444-5555-666666666666';
  const result = await getClaudeSessionTokenUsage(sessionId, {
    getSessionById: () => null,
    resolveJsonlPath: async () => null,
    readContextWindowOverride: () => null,
  });

  assert.deepEqual(result, {
    used: 0,
    total: 160000,
    breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
  });
});

test('getClaudeSessionTokenUsage honors the CONTEXT_WINDOW override', async () => {
  const sessionId = '33333333-4444-5555-6666-777777777777';
  const result = await getClaudeSessionTokenUsage(sessionId, {
    getSessionById: () => null,
    resolveJsonlPath: async () => null,
    readContextWindowOverride: () => 256000,
  });

  assert.equal(result.total, 256000);
  assert.equal(result.used, 0);
});

test('getClaudeSessionTokenUsage skips malformed JSONL lines and still returns the latest valid usage', async () => {
  const sessionId = '44444444-5555-6666-7777-888888888888';
  const { filePath, cleanup } = await createSandboxJsonl(sessionId, [
    JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } },
    }),
    '{this is not valid json',
    JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 } },
    }),
  ]);

  try {
    const result = await getClaudeSessionTokenUsage(sessionId, {
      getSessionById: () => ({ jsonl_path: filePath, project_path: '/home/jkready' }),
      resolveJsonlPath: async () => filePath,
      readContextWindowOverride: () => null,
    });

    assert.deepEqual(result.breakdown, { input: 5, cacheCreation: 7, cacheRead: 11 });
    assert.equal(result.used, 23);
  } finally {
    await cleanup();
  }
});

/**
 * The tail-read fast path (and its fallback) are the whole reason this endpoint
 * stopped being O(file). Both directions need covering: a usage record inside
 * the tail window must be found without a full scan, and one that only exists
 * *before* the window must still be found — otherwise a long transcript whose
 * recent turns carry no usage would silently report a zeroed budget.
 */
const TAIL_WINDOW_BYTES = 256 * 1024;

/** A filler row big enough that N of them push earlier rows out of the window. */
function paddingLine(index: number): string {
  return JSON.stringify({
    type: 'user',
    index,
    message: { role: 'user', content: 'x'.repeat(4096) },
  });
}

test('getClaudeSessionTokenUsage reads a usage record that sits inside the tail window', async () => {
  const sessionId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const lines = [
    // Older, and deliberately different: reading this one would mean the scan
    // walked past the newest record.
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } } }),
    ...Array.from({ length: 80 }, (_unused, index) => paddingLine(index)),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 41, cache_creation_input_tokens: 43, cache_read_input_tokens: 47 } } }),
  ];
  const { filePath, cleanup } = await createSandboxJsonl(sessionId, lines);

  try {
    const result = await getClaudeSessionTokenUsage(sessionId, {
      getSessionById: () => ({ jsonl_path: filePath, project_path: '/home/jkready' }),
      resolveJsonlPath: async () => filePath,
      readContextWindowOverride: () => null,
    });

    assert.deepEqual(result.breakdown, { input: 41, cacheCreation: 43, cacheRead: 47 });
    assert.equal(result.used, 131);
  } finally {
    await cleanup();
  }
});

test('getClaudeSessionTokenUsage falls back to a full scan when the tail holds no usage record', async () => {
  const sessionId = 'eeeeeeee-ffff-0000-1111-222222222222';
  // Enough padding after the usage row to bury it beyond the tail window.
  const paddingLines = Math.ceil((TAIL_WINDOW_BYTES / paddingLine(0).length) + 8);
  const lines = [
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 13, cache_creation_input_tokens: 17, cache_read_input_tokens: 19 } } }),
    ...Array.from({ length: paddingLines }, (_unused, index) => paddingLine(index)),
  ];
  const { filePath, cleanup } = await createSandboxJsonl(sessionId, lines);

  try {
    const result = await getClaudeSessionTokenUsage(sessionId, {
      getSessionById: () => ({ jsonl_path: filePath, project_path: '/home/jkready' }),
      resolveJsonlPath: async () => filePath,
      readContextWindowOverride: () => null,
    });

    assert.deepEqual(result.breakdown, { input: 13, cacheCreation: 17, cacheRead: 19 });
    assert.equal(result.used, 49);
  } finally {
    await cleanup();
  }
});

test('getClaudeSessionTokenUsage is not fooled by a partial line at the tail boundary', async () => {
  const sessionId = '33333333-4444-5555-6666-777777777777';
  // Sized so the window almost certainly lands mid-row: the first (truncated)
  // line of the tail must be discarded rather than parsed.
  const paddingLines = Math.ceil(TAIL_WINDOW_BYTES / paddingLine(0).length);
  const lines = [
    ...Array.from({ length: paddingLines }, (_unused, index) => paddingLine(index)),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5 } } }),
  ];
  const { filePath, cleanup } = await createSandboxJsonl(sessionId, lines);

  try {
    const result = await getClaudeSessionTokenUsage(sessionId, {
      getSessionById: () => ({ jsonl_path: filePath, project_path: '/home/jkready' }),
      resolveJsonlPath: async () => filePath,
      readContextWindowOverride: () => null,
    });

    assert.deepEqual(result.breakdown, { input: 2, cacheCreation: 3, cacheRead: 5 });
    assert.equal(result.used, 10);
  } finally {
    await cleanup();
  }
});
