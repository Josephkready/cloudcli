import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

      const caseAndWhitespaceVariant = await searchConversations('HISTORY   IS visible');
      assert.equal(caseAndWhitespaceVariant.totalMatches, 1);

      const separatedTerms = await searchConversations('visible History');
      assert.equal(
        separatedTerms.totalMatches,
        0,
        'multi-word queries still require the ordered adjacent phrase after candidate scanning',
      );
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

/*
 * Direction guard for the `fromEnd` history scan.
 *
 * agy appends to history.jsonl, so a conversation that gets renamed or moved
 * has more than one row and the LAST one is current. Every other fixture here
 * writes a single row per conversationId, which leaves the scan direction
 * unobservable — a reversed or off-by-one walk would pick the same row and no
 * assertion would notice.
 */
test('Antigravity synchronizer takes the newest history row for a conversation', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-session-newest-'));
  const stalePath = path.join(tempRoot, 'stale-workspace');
  const currentPath = path.join(tempRoot, 'current-workspace');
  const sessionId = 'agy-renamed-1';
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await mkdir(stalePath, { recursive: true });
    await mkdir(currentPath, { recursive: true });
    await writeTranscript(tempRoot, sessionId);

    const historyPath = path.join(tempRoot, '.gemini', 'antigravity-cli', 'history.jsonl');
    await writeFile(
      historyPath,
      [
        JSON.stringify({ display: 'Stale name', workspace: stalePath, conversationId: sessionId }),
        JSON.stringify({ display: 'Current name', workspace: currentPath, conversationId: sessionId }),
      ].join('\n') + '\n',
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      await new AntigravitySessionSynchronizer().synchronize();

      const session = sessionsDb.getSessionById(sessionId);
      assert.equal(session?.custom_name, 'Current name');
      assert.equal(session?.project_path, currentPath);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// Regression test for the bounded-concurrency perf fix: `synchronize()` now
// defers every discovered session's DB write to one batched call at the end
// of the scan, instead of writing each file's row immediately as the old
// sequential loop did. That changed what a per-file read failure costs: the
// old code rethrew from `processTranscriptFile`, which only aborted files
// scanned *after* the failing one (everything before it was already
// committed); with the write deferred to the end, the same rethrow would
// discard every already-parsed session in the batch, healthy or not. The fix
// makes `processTranscriptFile` swallow a read failure and return `null`
// instead of rethrowing — verified here directly (accessing the method via a
// loose cast, since chmod-based failure injection is not reliable when the
// test runner has root, which bypasses permission bits).
test('processTranscriptFile swallows a read failure instead of throwing', async () => {
  const missingTranscriptPath = path.join(
    '/nonexistent-antigravity-fixture', '.gemini', 'antigravity-cli', 'brain', 'agy-missing-1',
    '.system_generated', 'logs', 'transcript.jsonl',
  );

  const synchronizer = new AntigravitySessionSynchronizer() as unknown as {
    processTranscriptFile(
      filePath: string,
      lookupHistoryMetadata: (sessionId: string) => undefined,
    ): Promise<unknown>;
  };

  // The transcript path doesn't exist, so the inner `readFile` throws ENOENT.
  // A regression back to rethrowing would make this call reject instead of
  // resolving to `null`.
  const result = await synchronizer.processTranscriptFile(missingTranscriptPath, () => undefined);
  assert.equal(result, null);
});

test('a transcript that fails to read does not drop other sessions in the same scan', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-session-sync-partial-failure-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const restoreHomeDir = patchHomeDir(tempRoot);
  let unreadablePath: string | null = null;

  try {
    await mkdir(workspacePath, { recursive: true });
    await writeTranscript(tempRoot, 'agy-healthy-1');
    unreadablePath = await writeTranscript(tempRoot, 'agy-unreadable-1');

    // The transcript body alone carries no project path (no LIST_DIRECTORY /
    // VIEW_FILE step); history.jsonl supplies it, same as the other tests in
    // this file that expect a session to actually get indexed.
    const historyPath = path.join(tempRoot, '.gemini', 'antigravity-cli', 'history.jsonl');
    await writeFile(historyPath, `${JSON.stringify({
      display: 'Healthy session',
      workspace: workspacePath,
      conversationId: 'agy-healthy-1',
    })}\n`, 'utf8');

    // Best-effort permission-based failure injection: skipped (not failed) when
    // the test runner has root, since root bypasses permission bits and this
    // assertion would otherwise be unreliable across environments. The
    // privilege-independent regression coverage lives in the test above.
    await chmod(unreadablePath, 0o000);
    let readIsBlocked = true;
    try {
      await readFile(unreadablePath);
      readIsBlocked = false;
    } catch {
      // Expected when not running as root.
    }

    if (!readIsBlocked) {
      return;
    }

    await withIsolatedDatabase(async () => {
      const processed = await new AntigravitySessionSynchronizer().synchronize();

      // The healthy session survives even though its sibling failed to read.
      assert.ok(sessionsDb.getSessionById('agy-healthy-1'), 'healthy session should still be indexed');
      assert.equal(sessionsDb.getSessionById('agy-unreadable-1'), null);
      assert.equal(processed, 1);
    });
  } finally {
    if (unreadablePath) {
      await chmod(unreadablePath, 0o644).catch(() => {});
    }
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
