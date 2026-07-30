import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { AppError } from '../shared/utils.js';

import {
  createBugReportRouter,
  describeGhFailure,
  runGh,
  type GhResult,
} from './bug-report.js';

/*
 * The pure issue-shaping helpers are covered in server/shared/bug-report.test.ts.
 * This file covers the layer that actually talks to the world: the spawn wrapper
 * and the route's own branches, both of which are reachable without a real `gh`
 * or a GitHub round trip.
 */

const OK_RESULT: GhResult = {
  code: 0,
  stdout: 'https://github.com/owner/repo/issues/12\n',
  stderr: '',
};

/** Mounts the router behind the same error envelope server/index.js uses. */
function startServer(runner: (args: string[]) => Promise<GhResult>) {
  const app = express();
  app.use(express.json());
  app.use('/api/bug-report', createBugReportRouter({ runGh: runner }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  const server = http.createServer(app);
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function postReport(port: number, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/bug-report',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk as Buffer));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, json: text ? JSON.parse(text) : null });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

test('POST / files the issue and returns its URL', async () => {
  const calls: string[][] = [];
  const server = await startServer(async (args) => {
    calls.push(args);
    return OK_RESULT;
  });

  try {
    const response = await postReport(server.port, {
      description: 'the tab bar scrolls itself',
      metadata: { sessionId: 's1', provider: 'claude' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.data.issueUrl, 'https://github.com/owner/repo/issues/12');
    assert.equal(response.json.data.repo, 'Josephkready/cloudcli');

    const [args] = calls;
    assert.deepEqual(args.slice(0, 4), ['issue', 'create', '--repo', 'Josephkready/cloudcli']);
    assert.equal(args[5], 'Bug: the tab bar scrolls itself');
    // Metadata the client sent must survive into the body.
    assert.match(args[7], /\| Session ID \| `s1` \|/);
  } finally {
    await server.close();
  }
});

test('POST / stamps host facts the client cannot forge', async () => {
  const calls: string[][] = [];
  const server = await startServer(async (args) => {
    calls.push(args);
    return OK_RESULT;
  });

  try {
    await postReport(server.port, {
      description: 'a genuine report',
      metadata: { platform: 'commodore 64', nodeVersion: 'v0.0.1', reportedAt: '1999-01-01T00:00:00.000Z' },
    });

    const body = calls[0][7];
    assert.ok(!body.includes('commodore 64'), 'client-claimed platform must be overwritten');
    assert.ok(!body.includes('v0.0.1'), 'client-claimed node version must be overwritten');
    assert.ok(!body.includes('1999-01-01'), 'client-claimed timestamp must be overwritten');
    assert.match(body, new RegExp(`\\| Node version \\| \`${process.version}\` \\|`));
  } finally {
    await server.close();
  }
});

test('POST / rejects an empty description without calling gh', async () => {
  let called = false;
  const server = await startServer(async () => {
    called = true;
    return OK_RESULT;
  });

  try {
    const response = await postReport(server.port, { description: '   ' });

    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, 'BUG_REPORT_DESCRIPTION_REQUIRED');
    assert.match(response.json.error.message, /describe the bug/);
    assert.equal(called, false);
  } finally {
    await server.close();
  }
});

test('POST / tells an oversized report apart from an empty one', async () => {
  const server = await startServer(async () => OK_RESULT);

  try {
    const response = await postReport(server.port, { description: 'x'.repeat(20001) });

    assert.equal(response.status, 400);
    assert.match(response.json.error.message, /too long/);
  } finally {
    await server.close();
  }
});

test('POST / maps a non-zero gh exit to its user-facing message', async () => {
  const server = await startServer(async () => ({
    code: 1,
    stdout: '',
    stderr: 'gh: To get started with GitHub CLI, please run: gh auth login',
  }));

  try {
    const response = await postReport(server.port, { description: 'a genuine report' });

    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, 'BUG_REPORT_GH_UNAUTHENTICATED');
    // Raw gh stderr must never reach the client.
    assert.ok(!response.json.error.message.includes('gh: To get started'));
  } finally {
    await server.close();
  }
});

test('POST / reports a successful exit that yielded no issue URL', async () => {
  const server = await startServer(async () => ({ code: 0, stdout: 'nothing useful\n', stderr: '' }));

  try {
    const response = await postReport(server.port, { description: 'a genuine report' });

    assert.equal(response.status, 502);
    assert.equal(response.json.error.code, 'BUG_REPORT_NO_URL');
  } finally {
    await server.close();
  }
});

test('describeGhFailure maps each known gh stderr shape', () => {
  const cases: Array<[string, string, number]> = [
    ['gh: not logged into any GitHub hosts', 'BUG_REPORT_GH_UNAUTHENTICATED', 503],
    ['GraphQL: Could not resolve to a Repository with the name', 'BUG_REPORT_REPO_NOT_FOUND', 502],
    ['the repository has disabled issues', 'BUG_REPORT_ISSUES_DISABLED', 502],
    ['some entirely novel failure', 'BUG_REPORT_GH_FAILED', 502],
  ];

  for (const [stderr, code, statusCode] of cases) {
    const error = describeGhFailure(stderr);
    assert.equal(error.code, code, `stderr: ${stderr}`);
    assert.equal(error.statusCode, statusCode);
    assert.ok(!error.message.includes(stderr), 'raw stderr must not be echoed to the client');
  }
});

test('runGh maps a missing binary to an actionable 503', async () => {
  await assert.rejects(
    () => runGh(['issue', 'create'], 5000, 'gh-that-does-not-exist-cloudcli'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'BUG_REPORT_GH_MISSING');
      assert.equal(error.statusCode, 503);
      return true;
    },
  );
});

test('runGh kills a hung command and reports a timeout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bug-report-gh-'));
  const script = path.join(dir, 'slow.sh');
  await writeFile(script, '#!/bin/sh\nsleep 30\n');
  await chmod(script, 0o755);

  try {
    await assert.rejects(
      () => runGh([], 150, script),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'BUG_REPORT_GH_TIMEOUT');
        assert.equal(error.statusCode, 504);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runGh returns the captured streams and exit code of a real process', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bug-report-gh-'));
  const script = path.join(dir, 'noisy.sh');
  await writeFile(script, '#!/bin/sh\necho "on stdout"\necho "on stderr" >&2\nexit 3\n');
  await chmod(script, 0o755);

  try {
    const result = await runGh([], 5000, script);

    assert.equal(result.code, 3);
    assert.match(result.stdout, /on stdout/);
    assert.match(result.stderr, /on stderr/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
