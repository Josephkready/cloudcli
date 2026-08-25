import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

async function withIsolatedDatabase(
  runTest: (tempDirectory: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'bounded-history-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

test('Claude streams only the requested tail while preserving totals and tool pairing', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const sessionId = 'claude-bounded';
    const transcriptPath = path.join(tempDirectory, `${sessionId}.jsonl`);
    const rows: unknown[] = Array.from({ length: 25 }, (_, index) => index === 0
      ? {
          sessionId,
          uuid: 'message-0',
          timestamp: timestamp(index),
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'message-0-a' },
              { type: 'text', text: 'message-0-b' },
            ],
          },
        }
      : {
          sessionId,
          uuid: `message-${index}`,
          timestamp: timestamp(index),
          message: { role: 'assistant', content: `message-${index}` },
        });
    rows.push(
      {
        sessionId: 'some-other-session',
        timestamp: timestamp(25),
        message: { role: 'assistant', content: 'must not count' },
      },
      {
        sessionId,
        uuid: 'hidden-row',
        timestamp: timestamp(25),
        isMeta: true,
        message: { role: 'user', content: 'Base directory for this skill: /tmp/example' },
      },
      {
        sessionId,
        uuid: 'tool-use',
        timestamp: timestamp(25),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'true' } }],
        },
      },
      {
        sessionId,
        uuid: 'tool-result',
        timestamp: timestamp(26),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
        },
      },
      {
        sessionId,
        uuid: 'after-tool',
        timestamp: timestamp(27),
        message: { role: 'assistant', content: 'after-tool' },
      },
      {
        sessionId,
        uuid: 'final',
        timestamp: timestamp(28),
        message: { role: 'assistant', content: 'final' },
      },
    );
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(
      sessionId, 'claude', tempDirectory, 'Bounded Claude', undefined, undefined, transcriptPath,
    );

    const provider = new ClaudeSessionsProvider();
    const newest = await provider.fetchHistory(sessionId, {
      providerSessionId: sessionId,
      limit: 4,
      offset: 0,
    });

    assert.equal(newest.total, 29, 'total counts normalized messages, excluding tool results and hidden/foreign rows');
    assert.equal(newest.hasMore, true);
    assert.deepEqual(newest.messages.map((message) => message.kind), [
      'tool_use',
      'tool_result',
      'text',
      'text',
    ]);
    assert.equal(newest.messages[0]?.toolResult?.content, 'ok');

    const older = await provider.fetchHistory(sessionId, {
      providerSessionId: sessionId,
      limit: 3,
      offset: 4,
    });
    assert.deepEqual(older.messages.map((message) => message.content), [
      'message-22',
      'message-23',
      'message-24',
    ]);
    assert.equal(older.total, 29);
    assert.equal(older.hasMore, true);
  });
});

test('Codex streams only the requested tail while preserving totals, usage, and tool pairing', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const sessionId = 'codex-bounded';
    const transcriptPath = path.join(tempDirectory, `${sessionId}.jsonl`);
    const rows: unknown[] = Array.from({ length: 25 }, (_, index) => ({
      type: 'response_item',
      timestamp: timestamp(index),
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `message-${index}` }],
      },
    }));
    rows.push(
      {
        type: 'event_msg',
        timestamp: timestamp(25),
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 1234 }, model_context_window: 200_000 },
        },
      },
      {
        type: 'response_item',
        timestamp: timestamp(25),
        payload: {
          type: 'function_call',
          name: 'shell_command',
          arguments: JSON.stringify({ command: 'true' }),
          call_id: 'call-1',
        },
      },
      {
        type: 'response_item',
        timestamp: timestamp(26),
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
      },
      {
        type: 'response_item',
        timestamp: timestamp(27),
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'after-tool' }],
        },
      },
      {
        type: 'response_item',
        timestamp: timestamp(28),
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'final' }],
        },
      },
    );
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(
      sessionId, 'codex', tempDirectory, 'Bounded Codex', undefined, undefined, transcriptPath,
    );

    const provider = new CodexSessionsProvider();
    const newest = await provider.fetchHistory(sessionId, { limit: 4, offset: 0 });

    assert.equal(newest.total, 28);
    assert.equal(newest.hasMore, true);
    assert.deepEqual(newest.messages.map((message) => message.kind), [
      'tool_use',
      'tool_result',
      'text',
      'text',
    ]);
    assert.equal(newest.messages[0]?.toolResult?.content, 'ok');
    assert.deepEqual(newest.tokenUsage, { used: 1234, total: 200_000 });

    const older = await provider.fetchHistory(sessionId, { limit: 3, offset: 4 });
    assert.deepEqual(older.messages.map((message) => message.content), [
      'message-22',
      'message-23',
      'message-24',
    ]);
    assert.equal(older.total, 28);
    assert.equal(older.hasMore, true);
  });
});

test('Antigravity streams only the requested tail and skips malformed lines', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const sessionId = 'antigravity-bounded';
    const transcriptPath = path.join(tempDirectory, `${sessionId}.jsonl`);
    const rows: unknown[] = Array.from({ length: 25 }, (_, index) => ({
      step_index: index,
      created_at: timestamp(index),
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: `message-${index}`,
    }));
    rows.push(
      {
        step_index: 25,
        created_at: timestamp(25),
        source: 'MODEL',
        type: 'SHELL_OUTPUT',
        content: 'tool-output',
      },
      {
        step_index: 26,
        created_at: timestamp(26),
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        content: 'after-tool',
      },
      {
        step_index: 27,
        created_at: timestamp(27),
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: 'penultimate',
      },
      {
        step_index: 28,
        created_at: timestamp(28),
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        content: 'final',
      },
    );
    const lines = rows.map((row) => JSON.stringify(row));
    lines.splice(10, 0, '{malformed');
    await writeFile(transcriptPath, `${lines.join('\n')}\n`);
    sessionsDb.createSession(
      sessionId,
      'antigravity',
      tempDirectory,
      'Bounded Antigravity',
      undefined,
      undefined,
      transcriptPath,
    );

    const provider = new AntigravitySessionsProvider();
    const newest = await provider.fetchHistory(sessionId, { limit: 4, offset: 0 });

    assert.equal(newest.total, 29);
    assert.equal(newest.hasMore, true);
    assert.deepEqual(newest.messages.map((message) => message.content), [
      'tool-output',
      'after-tool',
      'penultimate',
      'final',
    ]);

    const older = await provider.fetchHistory(sessionId, { limit: 3, offset: 4 });
    assert.deepEqual(older.messages.map((message) => message.content), [
      'message-22',
      'message-23',
      'message-24',
    ]);
    assert.equal(older.total, 29);
    assert.equal(older.hasMore, true);
  });
});
