import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/*
 * `fetchHistory` used to fail open: every read error was swallowed and returned
 * as a well-formed empty page, so a transient failure reading the transcript
 * was indistinguishable on the wire from "this session has no messages".
 *
 * The client applied that empty page over the loaded conversation and the whole
 * thread vanished (fixed client-side in #320). This locks the other half: a
 * genuine read failure must be reported as a failure, so a cold load renders an
 * error state instead of an empty conversation that looks like data loss.
 *
 * The failure here is induced for real — the transcript path is a DIRECTORY, so
 * the read stream raises EISDIR — rather than mocked, so the test exercises the
 * same path a live failure would.
 */

async function withIsolatedDatabase(
  runTest: (tempDirectory: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-failopen-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

test('a genuine transcript read failure is reported, not returned as an empty session', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const projectPath = path.join(tempDirectory, 'project');
    await mkdir(projectPath, { recursive: true });

    // The "transcript" is a directory: opening it for reading raises EISDIR.
    const transcriptPath = path.join(tempDirectory, 'transcript.jsonl');
    await mkdir(transcriptPath, { recursive: true });

    sessionsDb.createSession(
      'sess-broken', 'claude', projectPath, 'Broken Session', undefined, undefined, transcriptPath,
    );

    const provider = new ClaudeSessionsProvider();

    await assert.rejects(
      () =>
        provider.fetchHistory('sess-broken', {
          limit: 20,
          offset: 0,
          projectPath,
          providerSessionId: 'sess-broken',
        }),
      'a failed transcript read must reject rather than resolve to an empty page',
    );
  });
});

test('a session with no transcript on disk is still a legitimate empty history', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const projectPath = path.join(tempDirectory, 'project');
    await mkdir(projectPath, { recursive: true });

    // No jsonl_path and nothing derivable on disk — a real "no messages yet"
    // session (e.g. created in the app before its first turn). This must stay
    // an empty result, NOT an error, or brand-new sessions break.
    sessionsDb.createSession('sess-empty', 'claude', projectPath, 'Empty Session');

    const provider = new ClaudeSessionsProvider();
    const result = await provider.fetchHistory('sess-empty', {
      limit: 20,
      offset: 0,
      projectPath,
      providerSessionId: 'sess-empty',
    });

    assert.equal(result.messages.length, 0);
    assert.equal(result.total, 0);
    assert.equal(result.hasMore, false);
  });
});

test('a readable transcript still parses normally', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const projectPath = path.join(tempDirectory, 'project');
    await mkdir(projectPath, { recursive: true });

    const transcriptPath = path.join(tempDirectory, 'good.jsonl');
    const rows = [
      { sessionId: 'sess-good', cwd: projectPath, timestamp: '2026-01-01T00:00:00.000Z', type: 'user', message: { role: 'user', content: 'hello' } },
      { sessionId: 'sess-good', cwd: projectPath, timestamp: '2026-01-01T00:00:01.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } },
    ];
    await writeFile(transcriptPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    sessionsDb.createSession(
      'sess-good', 'claude', projectPath, 'Good Session', undefined, undefined, transcriptPath,
    );

    const provider = new ClaudeSessionsProvider();
    const result = await provider.fetchHistory('sess-good', {
      limit: 20,
      offset: 0,
      projectPath,
      providerSessionId: 'sess-good',
    });

    assert.ok(result.messages.length > 0, 'a readable transcript must still yield messages');
  });
});
