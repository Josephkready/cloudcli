import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: typeof original }).homedir = original;
  };
};

async function withIsolatedDatabase(
  runTest: () => void | Promise<void>,
  // Fork feature (#6): the session synchronizers skip ephemeral project paths.
  // Setting the env var (even to '') fully replaces the defaults, so '' disables
  // the filter — which these tests want, because the default `/tmp/**` pattern
  // would exclude the os.tmpdir()-based fixtures wholesale.
  excludedProjectPaths: string = '',
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousExcludes = process.env.CLOUDCLI_EXCLUDED_PROJECT_PATHS;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.CLOUDCLI_EXCLUDED_PROJECT_PATHS = excludedProjectPaths;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousExcludes === undefined) {
      delete process.env.CLOUDCLI_EXCLUDED_PROJECT_PATHS;
    } else {
      process.env.CLOUDCLI_EXCLUDED_PROJECT_PATHS = previousExcludes;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one top-level Claude transcript at
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
 */
const writeClaudeTranscript = async (
  homeDir: string,
  sessionId: string,
  workspacePath: string,
  firstUserMessage = 'Fix the login redirect bug',
): Promise<string> => {
  const projectDir = path.join(homeDir, '.claude', 'projects', 'encoded-workspace');
  await mkdir(projectDir, { recursive: true });

  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({
      sessionId,
      cwd: workspacePath,
      type: 'user',
      message: { role: 'user', content: firstUserMessage },
    })}\n`,
    'utf8',
  );
  return filePath;
};

/**
 * Writes a subagent transcript at
 * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<n>.jsonl`.
 *
 * Claude Code repeats the *parent* session id inside these files, which is
 * exactly why they are dangerous: indexed as standalone sessions they overwrite
 * the parent row's `jsonl_path`.
 */
const writeClaudeSubagentTranscript = async (
  homeDir: string,
  parentSessionId: string,
  workspacePath: string,
  agentName = 'agent-x',
): Promise<string> => {
  const subagentDir = path.join(
    homeDir,
    '.claude',
    'projects',
    'encoded-workspace',
    parentSessionId,
    'subagents',
  );
  await mkdir(subagentDir, { recursive: true });

  const filePath = path.join(subagentDir, `${agentName}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({
      sessionId: parentSessionId,
      cwd: workspacePath,
      type: 'user',
      message: { role: 'user', content: 'subagent prompt' },
    })}\n`,
    'utf8',
  );
  return filePath;
};

test('Claude synchronizer skips subagents/ transcripts during a recursive scan', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-subagent-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const parentPath = await writeClaudeTranscript(tempRoot, 'claude-parent-1', workspacePath);
    await writeClaudeSubagentTranscript(tempRoot, 'claude-parent-1', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      // The subagent file is reached by the recursive scan but must never be
      // upserted: it repeats the parent id, so indexing it would rewrite the
      // parent row's jsonl_path to the subagent transcript.
      assert.equal(processed, 1);
      const row = sessionsDb.getSessionById('claude-parent-1');
      assert.ok(row, 'the parent session must still be indexed');
      assert.equal(row?.jsonl_path, parentPath);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer skips a subagent transcript handed straight to synchronizeFile', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-subagent-file-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const parentPath = await writeClaudeTranscript(tempRoot, 'claude-parent-2', workspacePath);
    const subagentPath = await writeClaudeSubagentTranscript(tempRoot, 'claude-parent-2', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();

      // The filesystem watcher feeds single files through this entry point, so
      // it needs its own guard — the recursive-scan filter never runs here.
      assert.equal(await synchronizer.synchronizeFile(parentPath), 'claude-parent-2');
      assert.equal(await synchronizer.synchronizeFile(subagentPath), null);

      assert.equal(sessionsDb.getSessionById('claude-parent-2')?.jsonl_path, parentPath);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer ignores non-jsonl files handed to synchronizeFile', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-ext-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      assert.equal(await synchronizer.synchronizeFile(path.join(tempRoot, 'notes.md')), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer skips sessions whose project path is excluded', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-excluded-'));
  const excludedPath = path.join(tempRoot, 'worktrees', 'feature-branch');
  await mkdir(excludedPath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Fork feature (#6): a session whose cwd is an ephemeral worktree must not be
    // auto-discovered into the sidebar. Sibling gate to the subagent skip above.
    await writeClaudeTranscript(tempRoot, 'claude-excluded-1', excludedPath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), 0);
      assert.equal(sessionsDb.getSessionById('claude-excluded-1'), null);
    }, '**/worktrees/**');
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Appends a title-bearing event to an existing transcript, the way Claude Code
 * does when its own titler finishes or the user renames a session in the CLI.
 */
const appendTranscriptEvent = async (
  filePath: string,
  event: Record<string, unknown>,
): Promise<void> => {
  await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
};

/*
 * Whether a name may be refreshed is a question about its *provenance*, not its
 * spelling (#379).
 *
 * Both synchronizers used to treat any name that wasn't the placeholder string
 * as final. That guard predates `name_source`, the column the database already
 * uses for exactly this decision:
 *
 *   custom_name = CASE WHEN name_source IS NULL THEN COALESCE(?, custom_name) ELSE custom_name END
 *
 * A user rename (`'user'`) and a finished AI title (`'ai'`) are deliberate acts
 * and must survive. A synchronizer-derived name, or #368's opening-line write,
 * has no source and should still yield to a real title event — otherwise Claude
 * Code's own `ai-title` can never be adopted, because #368 closes the path the
 * moment the first message is sent.
 */
test('Claude synchronizer adopts a later ai-title over an unsourced name', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-ai-title-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const filePath = await writeClaudeTranscript(
      tempRoot,
      'claude-ai-title-1',
      workspacePath,
      'Fix the login redirect bug',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();

      // The opening line, written with no provenance — exactly what #368 does at
      // send time, and the write that closes the path this test is about.
      sessionsDb.updateSessionCustomName('claude-ai-title-1', 'Fix the login redirect bug');
      const first = sessionsDb.getSessionById('claude-ai-title-1');
      assert.equal(first?.custom_name, 'Fix the login redirect bug');
      assert.equal(first?.name_source, null);

      // Claude Code's titler then writes its summary into the transcript.
      await appendTranscriptEvent(filePath, {
        sessionId: 'claude-ai-title-1',
        type: 'ai-title',
        aiTitle: 'Login redirect loop on expired session',
      });

      await synchronizer.synchronize();
      assert.equal(
        sessionsDb.getSessionById('claude-ai-title-1')?.custom_name,
        'Login redirect loop on expired session',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer leaves a user rename alone', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-user-name-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const filePath = await writeClaudeTranscript(tempRoot, 'claude-user-name-1', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();

      sessionsDb.updateSessionCustomName('claude-user-name-1', 'Renamed by me', 'user');
      await appendTranscriptEvent(filePath, {
        sessionId: 'claude-user-name-1',
        type: 'ai-title',
        aiTitle: 'A machine would have called it this',
      });

      await synchronizer.synchronize();
      // Deliberate intent outranks any discovered title, forever.
      assert.equal(sessionsDb.getSessionById('claude-user-name-1')?.custom_name, 'Renamed by me');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer leaves a finished AI title alone', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-ai-source-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const filePath = await writeClaudeTranscript(tempRoot, 'claude-ai-source-1', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();

      // cloudcli's own opt-in titler has already run and marked the row done.
      sessionsDb.updateSessionCustomName('claude-ai-source-1', 'Summarised by cloudcli', 'ai');
      await appendTranscriptEvent(filePath, {
        sessionId: 'claude-ai-source-1',
        type: 'ai-title',
        aiTitle: 'Summarised by Claude Code',
      });

      await synchronizer.synchronize();
      // Two titlers must not fight across every scan.
      assert.equal(
        sessionsDb.getSessionById('claude-ai-source-1')?.custom_name,
        'Summarised by cloudcli',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer never downgrades a real name to the placeholder', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-no-downgrade-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // A transcript that parses but carries no title-bearing event and no user
    // message, so discovery finds nothing at all.
    const projectDir = path.join(tempRoot, '.claude', 'projects', 'encoded-workspace');
    await mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, 'claude-no-downgrade-1.jsonl');
    await writeFile(
      filePath,
      `${JSON.stringify({
        sessionId: 'claude-no-downgrade-1',
        cwd: workspacePath,
        type: 'system',
      })}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();

      // An unsourced but perfectly good name — the shape #368 writes at send time.
      sessionsDb.updateSessionCustomName('claude-no-downgrade-1', 'Fix the login redirect bug');

      await synchronizer.synchronize();
      // Falling through the provenance guard must not let "found nothing" become
      // "call it Untitled". This is the regression the fix itself risks.
      assert.equal(
        sessionsDb.getSessionById('claude-no-downgrade-1')?.custom_name,
        'Fix the login redirect bug',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude synchronizer does not let a new prompt rewrite an existing name', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-churn-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const filePath = await writeClaudeTranscript(tempRoot, 'claude-churn-1', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      await synchronizer.synchronize();
      sessionsDb.updateSessionCustomName('claude-churn-1', 'Fix the login redirect bug');

      // A `last-prompt` is not a title — it is just whatever was typed most
      // recently. An app-created session has no history.jsonl entry, so nothing
      // outranks it in `pickDiscoveredSessionName`, and re-deriving on every scan
      // would march the sidebar name along with the conversation.
      await appendTranscriptEvent(filePath, {
        sessionId: 'claude-churn-1',
        type: 'last-prompt',
        lastPrompt: 'now also check the logout path',
      });

      await synchronizer.synchronize();
      assert.equal(
        sessionsDb.getSessionById('claude-churn-1')?.custom_name,
        'Fix the login redirect bug',
      );

      // ...but a real title event still wins, which is the whole point of #379.
      await appendTranscriptEvent(filePath, {
        sessionId: 'claude-churn-1',
        type: 'ai-title',
        aiTitle: 'Login redirect loop on expired session',
      });

      await synchronizer.synchronize();
      assert.equal(
        sessionsDb.getSessionById('claude-churn-1')?.custom_name,
        'Login redirect loop on expired session',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
