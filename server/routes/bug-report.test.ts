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
  runIssueQueue,
  validJobId,
  type QueueResult,
  type QueueRunner,
} from './bug-report.js';

const JOB_ID = 'abcdef12-abcd-4abc-8def-abcdef123456';
const OTHER_JOB_ID = 'bcdefa23-bcde-4bcd-9efa-bcdefa234567';

function result(payload: unknown, code = 0): QueueResult {
  return { code, stdout: JSON.stringify(payload), stderr: '' };
}

function startServer(runner: QueueRunner) {
  const app = express();
  app.use(express.json());
  app.use('/api/bug-report', createBugReportRouter({ runQueue: runner }));
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

function request(
  port: number,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk as Buffer));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('POST / durably queues the issue body over stdin and returns 202', async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const server = await startServer(async (args, input) => {
    calls.push({ args, input });
    return result({ status: 'queued', id: JOB_ID });
  });

  try {
    const response = await request(server.port, 'POST', '/api/bug-report', {
      description: 'the tab bar scrolls itself',
      metadata: { sessionId: 's1', provider: 'claude' },
    });

    assert.equal(response.status, 202);
    assert.deepEqual(response.json.data, {
      status: 'queued', id: JOB_ID, repo: 'Josephkready/cloudcli',
    });
    const [{ args, input }] = calls;
    assert.deepEqual(args.slice(0, 4), ['enqueue', '--repo', 'Josephkready/cloudcli', '--title']);
    assert.equal(args[4], 'Bug: the tab bar scrolls itself');
    assert.deepEqual(args.slice(-4), ['--label', 'bug', '--body-file', '-']);
    assert.match(input ?? '', /\| Session ID \| `s1` \|/);
    assert.ok(!args.includes(input ?? ''), 'the report body must never be placed in argv');
  } finally {
    await server.close();
  }
});

test('POST / stamps host facts the client cannot forge', async () => {
  const inputs: string[] = [];
  const server = await startServer(async (_args, input) => {
    inputs.push(input ?? '');
    return result({ status: 'queued', id: JOB_ID });
  });

  try {
    await request(server.port, 'POST', '/api/bug-report', {
      description: 'a genuine report',
      metadata: { platform: 'commodore 64', nodeVersion: 'v0.0.1', reportedAt: '1999-01-01' },
    });
    assert.ok(!inputs[0].includes('commodore 64'));
    assert.ok(!inputs[0].includes('v0.0.1'));
    assert.ok(!inputs[0].includes('1999-01-01'));
    assert.ok(inputs[0].includes('| Node version | `' + process.version + '` |'));
  } finally {
    await server.close();
  }
});

test('POST / rejects empty and oversized descriptions before queueing', async () => {
  let calls = 0;
  const server = await startServer(async () => {
    calls += 1;
    return result({ status: 'queued', id: JOB_ID });
  });

  try {
    const empty = await request(server.port, 'POST', '/api/bug-report', { description: '   ' });
    const long = await request(server.port, 'POST', '/api/bug-report', { description: 'x'.repeat(20001) });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'BUG_REPORT_DESCRIPTION_REQUIRED');
    assert.equal(long.status, 400);
    assert.match(long.json.error.message, /too long/);
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('POST / rejects an unconfirmed or malformed enqueue response', async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    for (const output of [
      result({ status: 'pending', id: JOB_ID }),
      result({ status: 'queued', id: 'bad' }),
      { code: 0, stdout: 'not json', stderr: '' },
    ]) {
      const server = await startServer(async () => output);
      try {
        const response = await request(server.port, 'POST', '/api/bug-report', { description: 'a genuine report' });
        assert.equal(response.status, 502);
        assert.equal(response.json.error.code, 'BUG_REPORT_QUEUE_PROTOCOL');
      } finally {
        await server.close();
      }
    }
    assert.ok(logged.some((entry) => JSON.stringify(entry).includes('protocol-error')));
    assert.ok(logged.every((entry) => JSON.stringify(entry).includes('enqueue')));
  } finally {
    console.error = original;
  }
});

test('POST / maps a queue command failure without exposing raw output', async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  const server = await startServer(async () => result({
    status: 'error', detail: 'database path /private/queue.db is unavailable',
  }, 2));

  try {
    const response = await request(server.port, 'POST', '/api/bug-report', { description: 'a genuine report' });
    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, 'BUG_REPORT_QUEUE_UNAVAILABLE');
    assert.ok(!response.json.error.message.includes('/private/queue.db'));
    assert.ok(!JSON.stringify(logged).includes('/private/queue.db'));
    assert.match(JSON.stringify(logged), /enqueue.*command-error.*2/);
  } finally {
    console.error = original;
    await server.close();
  }
});

test('GET /:jobId returns each content-free public queue state', async () => {
  for (const status of ['pending', 'retry', 'filing', 'filed', 'uncertain', 'failed']) {
    const calls: string[][] = [];
    const payload = { status, id: JOB_ID, ...(status === 'filed' ? {
      url: 'https://github.com/owner/repo/issues/12', number: 12,
    } : {}) };
    const server = await startServer(async (args) => {
      calls.push(args);
      return result(payload);
    });
    try {
      const response = await request(server.port, 'GET', `/api/bug-report/${JOB_ID}`);
      assert.equal(response.status, 200, status);
      assert.equal(response.json.data.status, status);
      assert.deepEqual(calls, [['status', JOB_ID]]);
    } finally {
      await server.close();
    }
  }
});

test('GET /:jobId rejects invalid input before invoking the queue', async () => {
  let called = false;
  const server = await startServer(async () => {
    called = true;
    return result({ status: 'pending', id: JOB_ID });
  });
  try {
    const response = await request(server.port, 'GET', '/api/bug-report/--help');
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, 'BUG_REPORT_JOB_ID_INVALID');
    assert.equal(called, false);
  } finally {
    await server.close();
  }
});

test('GET /:jobId rejects mismatched IDs and unknown states', async () => {
  for (const payload of [
    { status: 'pending', id: OTHER_JOB_ID },
    { status: 'invented', id: JOB_ID },
  ]) {
    const server = await startServer(async () => result(payload));
    try {
      const response = await request(server.port, 'GET', `/api/bug-report/${JOB_ID}`);
      assert.equal(response.status, 502);
      assert.equal(response.json.error.code, 'BUG_REPORT_QUEUE_PROTOCOL');
    } finally {
      await server.close();
    }
  }
});

test('validJobId accepts only canonical UUIDs', () => {
  assert.equal(validJobId(JOB_ID), true);
  assert.equal(validJobId(OTHER_JOB_ID), true);
  assert.equal(validJobId('--help'), false);
  assert.equal(validJobId(JOB_ID.toUpperCase()), false);
  assert.equal(validJobId(null), false);
});

test('runIssueQueue maps a missing binary without logging argv/title', async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await assert.rejects(
      () => runIssueQueue(['enqueue', '--title', 'private opening line'], '', 5000, 'missing-issue-queue-binary'),
      (error: unknown) => error instanceof AppError && error.code === 'BUG_REPORT_QUEUE_MISSING',
    );
    assert.ok(!JSON.stringify(logged).includes('private opening line'));
  } finally {
    console.error = original;
  }
});

test('runIssueQueue kills a hung command without logging argv/title', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bug-report-queue-'));
  const script = path.join(dir, 'slow.sh');
  await writeFile(script, '#!/bin/sh\nwhile :; do :; done\n');
  await chmod(script, 0o755);
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await assert.rejects(
      () => runIssueQueue(['enqueue', '--title', 'private opening line'], '', 150, script),
      (error: unknown) => error instanceof AppError && error.code === 'BUG_REPORT_QUEUE_TIMEOUT',
    );
    assert.ok(!JSON.stringify(logged).includes('private opening line'));
  } finally {
    console.error = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('runIssueQueue pipes stdin and captures a real process result', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bug-report-queue-'));
  const script = path.join(dir, 'queue.sh');
  await writeFile(script, '#!/bin/sh\nbody=$(cat)\nprintf \'{"status":"queued","id":"abcdef12-abcd-4abc-8def-abcdef123456"}\\n\'\nprintf \'received:%s\' "$body" >&2\n');
  await chmod(script, 0o755);
  try {
    const output = await runIssueQueue(['enqueue'], 'sensitive body', 5000, script);
    assert.equal(output.code, 0);
    assert.equal(JSON.parse(output.stdout).id, JOB_ID);
    assert.equal(output.stderr, 'received:sensitive body');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
