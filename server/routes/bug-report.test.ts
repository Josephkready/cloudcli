import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../shared/bug-report-attachments.js';
import { SCREENSHOTS_TOKEN } from '../shared/bug-report.js';
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

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jpeg-bytes')]);

type MultipartFile = { field: string; filename: string; contentType: string; data: Buffer };

function buildMultipartBody(
  fields: Record<string, string>,
  files: MultipartFile[],
): { body: Buffer; boundary: string } {
  const boundary = `cloudcliTestBoundary${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
    ));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

function requestMultipart(
  port: number,
  route: string,
  fields: Record<string, string>,
  files: MultipartFile[],
): Promise<{ status: number; json: any }> {
  const { body, boundary } = buildMultipartBody(fields, files);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk as Buffer));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function screenshotField(filename = 'shot.jpg', data: Buffer = JPEG): MultipartFile {
  return { field: 'attachments', filename, contentType: 'image/jpeg', data };
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

// --- screenshots (dante-config skills/bug-report-button/SKILL.md §9) --------

test('POST / with a multipart attachment writes a manifest and marks the body', async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const server = await startServer(async (args, input) => {
    calls.push({ args, input });
    return result({ status: 'queued', id: JOB_ID });
  });

  try {
    const response = await requestMultipart(
      server.port,
      '/api/bug-report',
      { description: 'see the attached screenshot', metadata: JSON.stringify({ sessionId: 's1' }) },
      [screenshotField()],
    );

    assert.equal(response.status, 202);
    assert.equal(response.json.data.status, 'queued');
    const [{ args, input }] = calls;
    const manifestIndex = args.indexOf('--attachments-manifest');
    assert.ok(manifestIndex >= 0, 'expected --attachments-manifest in argv');
    const manifestPath = args[manifestIndex + 1];
    assert.ok(manifestPath, 'expected a manifest path');
    assert.match(input ?? '', new RegExp(SCREENSHOTS_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(input ?? '', /\| Session ID \| `s1` \|/);
    // Durable before the response returns: the runner (playing issue-queue's role) can still
    // read the manifest and the file it names WHILE this call is in flight.
  } finally {
    await server.close();
  }
});

test('POST / with no attachments in a multipart request behaves like the JSON path', async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const server = await startServer(async (args, input) => {
    calls.push({ args, input });
    return result({ status: 'queued', id: JOB_ID });
  });

  try {
    const response = await requestMultipart(
      server.port,
      '/api/bug-report',
      { description: 'no screenshot needed for this one' },
      [],
    );
    assert.equal(response.status, 202);
    const [{ args, input }] = calls;
    assert.ok(!args.includes('--attachments-manifest'));
    assert.ok(!(input ?? '').includes(SCREENSHOTS_TOKEN));
  } finally {
    await server.close();
  }
});

test('POST / rejects more than MAX_ATTACHMENTS screenshots with 413', async () => {
  let called = false;
  const server = await startServer(async () => {
    called = true;
    return result({ status: 'queued', id: JOB_ID });
  });

  try {
    const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => screenshotField(`${i}.jpg`));
    const response = await requestMultipart(server.port, '/api/bug-report', { description: 'too many' }, files);
    assert.equal(response.status, 413);
    assert.equal(response.json.error.code, 'BUG_REPORT_ATTACHMENT_COUNT');
    assert.equal(called, false);
  } finally {
    await server.close();
  }
});

test('POST / rejects an oversized attachment with 413, measured on received bytes', async () => {
  let called = false;
  const server = await startServer(async () => {
    called = true;
    return result({ status: 'queued', id: JOB_ID });
  });

  try {
    const oversized = Buffer.concat([JPEG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    const response = await requestMultipart(
      server.port,
      '/api/bug-report',
      { description: 'huge image' },
      [screenshotField('big.jpg', oversized)],
    );
    assert.equal(response.status, 413);
    assert.equal(response.json.error.code, 'BUG_REPORT_ATTACHMENT_TOO_LARGE');
    assert.equal(called, false);
  } finally {
    await server.close();
  }
});

test('POST / rejects a non-image attachment with 415, regardless of the claimed content-type', async () => {
  let called = false;
  const server = await startServer(async () => {
    called = true;
    return result({ status: 'queued', id: JOB_ID });
  });

  try {
    const response = await requestMultipart(
      server.port,
      '/api/bug-report',
      { description: 'not really an image' },
      [{ field: 'attachments', filename: 'shot.jpg', contentType: 'image/jpeg', data: Buffer.from('not an image') }],
    );
    assert.equal(response.status, 415);
    assert.equal(response.json.error.code, 'BUG_REPORT_ATTACHMENT_TYPE');
    assert.equal(called, false);
  } finally {
    await server.close();
  }
});

test('POST / removes its attachment temp files once the response has been sent', async () => {
  const seenPaths: string[] = [];
  const existedDuringCall: boolean[] = [];
  const server = await startServer(async (args) => {
    const manifestIndex = args.indexOf('--attachments-manifest');
    const manifestPath = args[manifestIndex + 1];
    seenPaths.push(manifestPath);
    // The manifest — and every file it names — must still exist WHILE the queue
    // command runs; only after this returns does the route clean them up.
    existedDuringCall.push(existsSync(manifestPath));
    return result({ status: 'queued', id: JOB_ID });
  });

  try {
    const response = await requestMultipart(
      server.port,
      '/api/bug-report',
      { description: 'cleans up after itself' },
      [screenshotField()],
    );
    assert.equal(response.status, 202);
    assert.deepEqual(existedDuringCall, [true]);
    assert.equal(seenPaths.length, 1);
    assert.equal(existsSync(seenPaths[0]), false);
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
