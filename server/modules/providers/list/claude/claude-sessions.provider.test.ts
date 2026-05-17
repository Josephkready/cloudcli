import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveClaudeJsonlPath } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * Helper that mints a fresh sandbox directory tree mimicking the layout of
 * `~/.claude/projects` so we can exercise the recovery branches without
 * touching real user data.
 */
async function createSandbox(): Promise<{ root: string; cleanup: () => Promise<void>; originalHome: string | undefined }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-sessions-test-'));
  const originalHome = process.env.HOME;
  process.env.HOME = root;

  await fsp.mkdir(path.join(root, '.claude', 'projects'), { recursive: true });

  return {
    root,
    originalHome,
    cleanup: async () => {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

test('resolveClaudeJsonlPath returns stored path when it exists', async () => {
  const { root, cleanup } = await createSandbox();
  try {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const projectDir = path.join(root, '.claude', 'projects', '-home-jkready');
    await fsp.mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    await fsp.writeFile(filePath, '{"sessionId":"' + sessionId + '"}\n');

    const resolved = await resolveClaudeJsonlPath(filePath, sessionId, '/home/jkready');
    assert.equal(resolved, filePath);
  } finally {
    await cleanup();
  }
});

test('resolveClaudeJsonlPath falls back to home-dir rewrite when stored path is stale', async () => {
  const { root, cleanup } = await createSandbox();
  try {
    const sessionId = '22222222-3333-4444-5555-666666666666';
    const projectDir = path.join(root, '.claude', 'projects', '-home-jkready');
    await fsp.mkdir(projectDir, { recursive: true });
    const realFilePath = path.join(projectDir, `${sessionId}.jsonl`);
    await fsp.writeFile(realFilePath, 'data\n');

    // Simulate a stored path under a stale HOME (e.g. /home/node from an
    // older deploy where the container ran as the `node` user).
    const stalePath = `/home/node/.claude/projects/-home-jkready/${sessionId}.jsonl`;

    const resolved = await resolveClaudeJsonlPath(stalePath, sessionId, '/home/jkready');
    assert.equal(resolved, realFilePath);
  } finally {
    await cleanup();
  }
});

test('resolveClaudeJsonlPath falls back to project-path derivation when stored path is missing entirely', async () => {
  const { root, cleanup } = await createSandbox();
  try {
    const sessionId = '33333333-4444-5555-6666-777777777777';
    const projectPath = '/home/jkready/myproject';
    const encoded = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
    const projectDir = path.join(root, '.claude', 'projects', encoded);
    await fsp.mkdir(projectDir, { recursive: true });
    const realFilePath = path.join(projectDir, `${sessionId}.jsonl`);
    await fsp.writeFile(realFilePath, 'data\n');

    const resolved = await resolveClaudeJsonlPath(null, sessionId, projectPath);
    assert.equal(resolved, realFilePath);
  } finally {
    await cleanup();
  }
});

test('resolveClaudeJsonlPath returns null when no candidate path exists', async () => {
  const { cleanup } = await createSandbox();
  try {
    const resolved = await resolveClaudeJsonlPath(
      '/nonexistent/path.jsonl',
      'never-indexed-session-id',
      '/home/jkready/missing-project',
    );
    assert.equal(resolved, null);
  } finally {
    await cleanup();
  }
});

test('resolveClaudeJsonlPath prefers home-rewrite recovery even when project_path is also valid', async () => {
  // This guards the invariant that the home-rewrite recovery is tried first.
  // If the stored path's basename is wrong (e.g. corrupted), only the
  // project_path derivation would find the file.
  const { root, cleanup } = await createSandbox();
  try {
    const sessionId = '44444444-5555-6666-7777-888888888888';
    const projectPath = '/home/jkready';
    const encoded = '-home-jkready';
    const projectDir = path.join(root, '.claude', 'projects', encoded);
    await fsp.mkdir(projectDir, { recursive: true });
    const realFilePath = path.join(projectDir, `${sessionId}.jsonl`);
    await fsp.writeFile(realFilePath, 'data\n');

    // Stored path under a stale HOME — home-rewrite recovery should hit
    // first.
    const stalePath = `/home/node/.claude/projects/-home-jkready/${sessionId}.jsonl`;

    const resolved = await resolveClaudeJsonlPath(stalePath, sessionId, projectPath);
    assert.equal(resolved, realFilePath);
  } finally {
    await cleanup();
  }
});
