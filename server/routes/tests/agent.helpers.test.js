import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  normalizeGitHubUrl,
  parseGitHubUrl,
  autogenerateBranchName,
  validateBranchName,
  getGitRemoteUrl,
  getCommitMessages,
  createGitHubBranch,
  createGitHubPR,
  cloneGitHubRepo,
  cleanupProject,
  SSEStreamWriter,
} from '../agent.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

test('normalizeGitHubUrl strips .git, converts ssh to https, lowercases, trims slash', () => {
  assert.equal(
    normalizeGitHubUrl('https://github.com/Owner/Repo.git'),
    'https://github.com/owner/repo',
  );
  assert.equal(
    normalizeGitHubUrl('https://github.com/Owner/Repo/'),
    'https://github.com/owner/repo',
  );
  assert.equal(
    normalizeGitHubUrl('git@github.com:Owner/Repo.git'),
    'https://github.com/owner/repo',
  );
});

test('parseGitHubUrl extracts owner/repo from https and ssh urls', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/foo/bar'), { owner: 'foo', repo: 'bar' });
  assert.deepEqual(parseGitHubUrl('https://github.com/foo/bar.git'), { owner: 'foo', repo: 'bar' });
  assert.deepEqual(parseGitHubUrl('git@github.com:foo/bar.git'), { owner: 'foo', repo: 'bar' });
});

test('parseGitHubUrl throws on unrecognized url', () => {
  assert.throws(() => parseGitHubUrl('https://example.com/foo/bar'), /Invalid GitHub URL format/);
});

test('autogenerateBranchName slugifies message and appends a timestamp suffix', () => {
  const name = autogenerateBranchName('Fix the Login Bug!!');
  assert.match(name, /^fix-the-login-bug-[a-z0-9]+$/);
});

test('autogenerateBranchName falls back to "task" for an empty/symbol-only message', () => {
  const name = autogenerateBranchName('!!!???');
  assert.match(name, /^task-[a-z0-9]+$/);
});

test('autogenerateBranchName truncates long messages to fit the length budget', () => {
  const longMessage = 'word '.repeat(30);
  const name = autogenerateBranchName(longMessage);
  assert.ok(name.length <= 50, `expected <=50 chars, got ${name.length}`);
});

test('validateBranchName rejects empty names', () => {
  assert.deepEqual(validateBranchName(''), { valid: false, error: 'Branch name cannot be empty' });
  assert.deepEqual(validateBranchName('   '), { valid: false, error: 'Branch name cannot be empty' });
});

test('validateBranchName rejects each documented invalid pattern', () => {
  assert.equal(validateBranchName('.feature').error, 'Branch name cannot start with a dot');
  assert.equal(validateBranchName('feature.').error, 'Branch name cannot end with a dot');
  assert.equal(validateBranchName('fea..ture').error, 'Branch name cannot contain consecutive dots (..)');
  assert.equal(validateBranchName('my branch').error, 'Branch name cannot contain spaces');
  assert.equal(validateBranchName('fea~ture').error, 'Branch name cannot contain special characters: ~ ^ : ? * [ \\');
  assert.equal(validateBranchName('fea@{ture').error, 'Branch name cannot contain @{');
  assert.equal(validateBranchName('feature/').error, 'Branch name cannot end with a slash');
  assert.equal(validateBranchName('/feature').error, 'Branch name cannot start with a slash');
  assert.equal(validateBranchName('fea//ture').error, 'Branch name cannot contain consecutive slashes');
  assert.equal(validateBranchName('feature.lock').error, 'Branch name cannot end with .lock');
  assert.equal(validateBranchName('fea\x01ture').error, 'Branch name cannot contain control characters');
});

test('validateBranchName accepts a well-formed name', () => {
  assert.deepEqual(validateBranchName('feature/user-auth'), { valid: true });
});

// ---------------------------------------------------------------------------
// SSEStreamWriter
// ---------------------------------------------------------------------------

function makeFakeRes() {
  const writes = [];
  return {
    writableEnded: false,
    write(chunk) {
      writes.push(chunk);
    },
    end() {
      this.writableEnded = true;
    },
    writes,
  };
}

test('SSEStreamWriter.send writes a JSON-encoded SSE frame', () => {
  const res = makeFakeRes();
  const writer = new SSEStreamWriter(res, 'user-1');
  writer.send({ hello: 'world' });
  assert.equal(res.writes.length, 1);
  assert.equal(res.writes[0], 'data: {"hello":"world"}\n\n');
});

test('SSEStreamWriter.send is a no-op once the response has ended', () => {
  const res = makeFakeRes();
  res.writableEnded = true;
  const writer = new SSEStreamWriter(res);
  writer.send({ hello: 'world' });
  assert.equal(res.writes.length, 0);
});

test('SSEStreamWriter.end writes the done sentinel and ends the response once', () => {
  const res = makeFakeRes();
  const writer = new SSEStreamWriter(res);
  writer.end();
  assert.equal(res.writes.length, 1);
  assert.equal(res.writes[0], 'data: {"type":"done"}\n\n');
  assert.equal(res.writableEnded, true);

  // Calling end() again after writableEnded is true must not double-write.
  writer.end();
  assert.equal(res.writes.length, 1);
});

test('SSEStreamWriter set/getSessionId round-trips and emits a session-id frame', () => {
  const res = makeFakeRes();
  const writer = new SSEStreamWriter(res);
  writer.setSessionId('abc-123');
  assert.equal(writer.getSessionId(), 'abc-123');
  assert.equal(res.writes[0], 'data: {"type":"session-id","sessionId":"abc-123"}\n\n');
});

// ---------------------------------------------------------------------------
// Git-backed helpers (against a real temp git repo -- no network)
// ---------------------------------------------------------------------------

async function makeTempGitRepo(remoteUrl) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-git-'));
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  if (remoteUrl) {
    await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
  }
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'first commit'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'second commit'], { cwd: dir });
  return dir;
}

test('getGitRemoteUrl resolves the origin remote of a real repo', async (t) => {
  const dir = await makeTempGitRepo('https://github.com/foo/bar.git');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await getGitRemoteUrl(dir);
  assert.equal(url, 'https://github.com/foo/bar.git');
});

test('getGitRemoteUrl rejects when there is no such remote', async (t) => {
  const dir = await makeTempGitRepo(null);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(getGitRemoteUrl(dir), /Failed to get git remote/);
});

test('getCommitMessages returns recent commit subjects newest first', async (t) => {
  const dir = await makeTempGitRepo(null);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const messages = await getCommitMessages(dir, 5);
  assert.deepEqual(messages, ['second commit', 'first commit']);
});

test('getCommitMessages rejects for a non-git directory', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-nogit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(getCommitMessages(dir, 5), /Failed to get commit messages/);
});

test('cloneGitHubRepo reuses an existing repo when the remote URL already matches', async (t) => {
  const dir = await makeTempGitRepo('https://github.com/foo/bar.git');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await cloneGitHubRepo('https://github.com/foo/bar.git', null, dir);
  assert.equal(result, path.resolve(dir));
});

test('cloneGitHubRepo rejects when the directory already exists with a different repo', async (t) => {
  const dir = await makeTempGitRepo('https://github.com/foo/bar.git');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    cloneGitHubRepo('https://github.com/other/repo.git', null, dir),
    /already exists with a different repository/,
  );
});

test('cloneGitHubRepo rejects when the existing directory is not a git repo', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-notgit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    cloneGitHubRepo('https://github.com/foo/bar.git', null, dir),
    /already exists but is not a valid git repository/,
  );
});

test('cloneGitHubRepo rejects an invalid GitHub URL before touching the filesystem', async () => {
  await assert.rejects(cloneGitHubRepo('not-a-url', null, '/tmp/should-not-be-created-agent-test'), /Invalid GitHub URL/);
});

// ---------------------------------------------------------------------------
// GitHub API helpers (fake Octokit -- no network)
// ---------------------------------------------------------------------------

function makeFakeOctokit(overrides = {}) {
  return {
    git: {
      getRef: async () => ({ data: { object: { sha: 'deadbeef' } } }),
      createRef: async () => ({}),
      ...overrides.git,
    },
    pulls: {
      create: async () => ({ data: { number: 42, html_url: 'https://github.com/foo/bar/pull/42' } }),
      ...overrides.pulls,
    },
  };
}

test('createGitHubBranch creates a ref from the base branch sha', async () => {
  let createRefArgs = null;
  const octokit = makeFakeOctokit({
    git: {
      getRef: async (args) => {
        assert.equal(args.ref, 'heads/main');
        return { data: { object: { sha: 'deadbeef' } } };
      },
      createRef: async (args) => {
        createRefArgs = args;
        return {};
      },
    },
  });
  await createGitHubBranch(octokit, 'foo', 'bar', 'feature/x');
  assert.deepEqual(createRefArgs, {
    owner: 'foo',
    repo: 'bar',
    ref: 'refs/heads/feature/x',
    sha: 'deadbeef',
  });
});

test('createGitHubBranch swallows a "Reference already exists" 422', async () => {
  const octokit = makeFakeOctokit({
    git: {
      getRef: async () => ({ data: { object: { sha: 'deadbeef' } } }),
      createRef: async () => {
        const err = new Error('Reference already exists');
        err.status = 422;
        throw err;
      },
    },
  });
  await createGitHubBranch(octokit, 'foo', 'bar', 'feature/x'); // must not throw
});

test('createGitHubBranch rethrows other errors', async () => {
  const octokit = makeFakeOctokit({
    git: {
      getRef: async () => ({ data: { object: { sha: 'deadbeef' } } }),
      createRef: async () => {
        throw new Error('boom');
      },
    },
  });
  await assert.rejects(createGitHubBranch(octokit, 'foo', 'bar', 'feature/x'), /boom/);
});

test('createGitHubPR creates a pull request and returns number/url', async () => {
  const octokit = makeFakeOctokit();
  const result = await createGitHubPR(octokit, 'foo', 'bar', 'feature/x', 'Title', 'Body');
  assert.deepEqual(result, { number: 42, url: 'https://github.com/foo/bar/pull/42' });
});

// ---------------------------------------------------------------------------
// cleanupProject
// ---------------------------------------------------------------------------

test('cleanupProject refuses to delete a path outside .claude/external-projects', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'keep-me'), { recursive: true });
  await cleanupProject(path.join(dir, 'keep-me'));
  // Directory must still exist -- cleanupProject refused to touch it.
  const { access } = await import('node:fs/promises');
  await access(path.join(dir, 'keep-me'));
});

test('cleanupProject removes a directory under .claude/external-projects', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const externalProject = path.join(dir, '.claude', 'external-projects', 'proj1');
  await mkdir(externalProject, { recursive: true });
  await cleanupProject(externalProject);
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(externalProject));
});
