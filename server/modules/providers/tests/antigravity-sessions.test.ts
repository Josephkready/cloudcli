import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  AntigravitySessionSynchronizer,
  getAntigravitySessionIdFromTranscriptPath,
  stripAntigravityTranscriptTags,
} from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';
import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as typeof os & { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as typeof os & { homedir: () => string }).homedir = original;
  };
};

async function withIsolatedDatabase(
  run: () => void | Promise<void>,
  // Fork feature (#6): the session synchronizers skip ephemeral project paths.
  // Setting the env var (even to '') fully replaces the defaults, so '' disables
  // the filter — which most tests here want, because the default `/tmp/**`
  // pattern would exclude these os.tmpdir()-based fixtures wholesale. Pass a
  // pattern to exercise the filter itself; see the exclude-gate test below.
  // Mirrors the codex/claude synchronizer suites.
  excludedProjectPaths: string = '',
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousExcludes = process.env.CLOUDCLI_EXCLUDED_PROJECT_PATHS;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'antigravity-provider-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'cloudcli.db');
  process.env.CLOUDCLI_EXCLUDED_PROJECT_PATHS = excludedProjectPaths;
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousExcludes === undefined) delete process.env.CLOUDCLI_EXCLUDED_PROJECT_PATHS;
    else process.env.CLOUDCLI_EXCLUDED_PROJECT_PATHS = previousExcludes;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function writeTranscript(
  homeDir: string,
  sessionId: string,
  userMessage = 'Fix Antigravity history',
  assistantMessage = 'History is visible now.',
): Promise<string> {
  const logsDir = path.join(
    homeDir,
    '.gemini',
    'antigravity-cli',
    'brain',
    sessionId,
    '.system_generated',
    'logs',
  );
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  const lines = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-07-17T05:37:32Z',
      content: `<USER_REQUEST>\n${userMessage}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignored\n</ADDITIONAL_METADATA>`,
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-07-17T05:37:33Z',
      content: assistantMessage,
    },
    '{partially-written',
  ];
  await writeFile(
    transcriptPath,
    `${lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  );
  return transcriptPath;
}

test('Antigravity transcript helpers extract ids and remove injected tags', () => {
  const transcript = path.join(
    '/home/test',
    '.gemini',
    'antigravity-cli',
    'brain',
    'native-id',
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  assert.equal(getAntigravitySessionIdFromTranscriptPath(transcript), 'native-id');
  assert.equal(
    stripAntigravityTranscriptTags(
      '<USER_REQUEST>\nHello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignored\n</ADDITIONAL_METADATA>',
    ),
    'Hello',
  );
});

test('Antigravity synchronizer indexes transcript rows from history metadata', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-session-sync-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const sessionId = 'agy-session-1';
  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = await writeTranscript(tempRoot, sessionId);
    const historyPath = path.join(tempRoot, '.gemini', 'antigravity-cli', 'history.jsonl');
    await writeFile(historyPath, `${JSON.stringify({
      display: 'Fix Antigravity history',
      workspace: workspacePath,
      conversationId: sessionId,
    })}\n{partially-written\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      await new AntigravitySessionSynchronizer().synchronize();
      const session = sessionsDb.getSessionById(sessionId);
      assert.equal(session?.provider, 'antigravity');
      assert.equal(session?.project_path, workspacePath);
      assert.equal(session?.jsonl_path, transcriptPath);
      assert.equal(session?.custom_name, 'Fix Antigravity history');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Antigravity synchronizer skips sessions whose project path is excluded', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-session-sync-excluded-'));
  const keptPath = path.join(tempRoot, 'workspace');
  const excludedPath = path.join(tempRoot, 'worktrees', 'feature-branch');
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Fork feature (#6): a session whose workspace is an ephemeral worktree must
    // not be auto-discovered into the sidebar. Codex and Claude each pin this
    // gate in their own suite; Antigravity was the one synchronizer calling
    // shouldExcludeProjectPath with nothing asserting it. Every other test here
    // disables the filter, so deleting the gate from synchronizeFile() would
    // otherwise leave this file green.
    await mkdir(keptPath, { recursive: true });
    await mkdir(excludedPath, { recursive: true });
    await writeTranscript(tempRoot, 'agy-kept-1');
    await writeTranscript(tempRoot, 'agy-excluded-1');

    // The synchronizer reads the workspace for each session from history.jsonl,
    // so the two sessions are what map onto the kept/excluded paths.
    const historyPath = path.join(tempRoot, '.gemini', 'antigravity-cli', 'history.jsonl');
    await writeFile(
      historyPath,
      [
        JSON.stringify({ display: 'Kept', workspace: keptPath, conversationId: 'agy-kept-1' }),
        JSON.stringify({
          display: 'Excluded',
          workspace: excludedPath,
          conversationId: 'agy-excluded-1',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const processed = await new AntigravitySessionSynchronizer().synchronize();

      // Only the non-excluded transcript is indexed.
      assert.equal(processed, 1);
      assert.ok(sessionsDb.getSessionById('agy-kept-1'));
      assert.equal(sessionsDb.getSessionById('agy-excluded-1'), null);
    }, '**/worktrees/**');
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Antigravity history reader normalizes messages and skips malformed lines', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-history-'));
  try {
    const transcriptPath = await writeTranscript(tempRoot, 'agy-session-2');
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        'agy-session-2',
        'antigravity',
        tempRoot,
        'History test',
        undefined,
        undefined,
        transcriptPath,
      );
      const history = await new AntigravitySessionsProvider().fetchHistory('agy-session-2');

      assert.equal(history.total, 2);
      assert.equal(history.messages[0]?.role, 'user');
      assert.equal(history.messages[0]?.content, 'Fix Antigravity history');
      assert.equal(history.messages[1]?.role, 'assistant');
      assert.equal(history.messages[1]?.content, 'History is visible now.');

      const search = await searchConversations('visible now');
      assert.equal(search.totalMatches, 1);
      assert.equal(search.results[0]?.sessions[0]?.provider, 'antigravity');
      assert.equal(search.results[0]?.sessions[0]?.sessionId, 'agy-session-2');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Antigravity history read failures remain distinguishable from empty sessions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-history-error-'));
  try {
    await withIsolatedDatabase(async () => {
      const missingPath = path.join(tempRoot, 'missing-transcript.jsonl');
      sessionsDb.createSession(
        'agy-missing',
        'antigravity',
        tempRoot,
        'Missing history',
        undefined,
        undefined,
        missingPath,
      );

      await assert.rejects(
        new AntigravitySessionsProvider().fetchHistory('agy-missing'),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'SESSION_TRANSCRIPT_UNREADABLE');
          return true;
        },
      );
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
