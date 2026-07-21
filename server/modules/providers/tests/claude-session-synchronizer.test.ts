import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
