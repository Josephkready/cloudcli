import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { FlowStore } from '../flow-store.js';
import {
  MAX_BODY_BYTES,
  createVdebugCaptureRouter,
  resolveVdebugCaptureConfig,
  type VdebugCaptureConfig,
} from '../vdebug-capture.routes.js';

const quietLogger = () => {
  const lines: string[] = [];
  return { lines, logger: { warn: (m: string) => lines.push(m) } };
};

async function withServer(
  overrides: Partial<VdebugCaptureConfig>,
  fn: (baseUrl: string, config: VdebugCaptureConfig, logLines: string[]) => Promise<void>,
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vd-capture-route-'));
  const config: VdebugCaptureConfig = {
    enabled: true,
    dbPath: path.join(dir, 'flows.db'),
    retentionDays: 30,
    maxBatchesPerMinute: 300,
    ...overrides,
  };
  const { lines, logger } = quietLogger();
  const app = express();
  app.use(createVdebugCaptureRouter(config, { logger }));
  // Stand-ins for what server/index.js mounts after the capture router.
  app.use(express.json({ limit: '50mb' }));
  app.get('/vd-recorder.js', (_req, res) => res.type('js').send('/* real recorder */'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`, config, lines);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    // Let the router's startup prune (setImmediate) finish before deleting its dir.
    await new Promise((resolve) => setImmediate(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = (baseUrl: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/api/_vd/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

const goodBatch = JSON.stringify({
  session_id: 'route0session1',
  viewport: { w: 1440, h: 900 },
  events: [
    { seq: 0, t: 0, type: 'nav', path: '/', data: { kind: 'load' } },
    { seq: 1, t: 3, type: 'input', data: { kind: 'textarea', length: 12, value: 'TOP SECRET' } },
  ],
});

test('POST stores a valid batch and answers 204; the stored rows carry no input value', async () => {
  await withServer({}, async (baseUrl, config) => {
    const res = await post(baseUrl, goodBatch, { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' });
    assert.equal(res.status, 204);
    const again = await post(baseUrl, goodBatch);
    assert.equal(again.status, 204);
    const store = new FlowStore(config.dbPath);
    try {
      const rows = store.db.prepare('SELECT data FROM events').all();
      assert.equal(rows.length, 2, 're-sent batch must not duplicate rows');
      assert.ok(!JSON.stringify(rows).includes('SECRET'));
      const s = store.db.prepare('SELECT ua_class FROM sessions').get() as { ua_class: string };
      assert.equal(s.ua_class, 'desktop');
    } finally {
      store.close();
    }
  });
});

test('accepts sendBeacon-style text/plain bodies', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await post(baseUrl, goodBatch, { 'content-type': 'text/plain;charset=UTF-8' });
    assert.equal(res.status, 204);
  });
});

test('malformed JSON and invalid batches answer 400, oversize bodies 413 — never 5xx', async () => {
  await withServer({}, async (baseUrl) => {
    assert.equal((await post(baseUrl, '{not json')).status, 400);
    assert.equal((await post(baseUrl, JSON.stringify({ session_id: 'x', events: [] }))).status, 400);
    const huge = JSON.stringify({ session_id: 'route0session1', events: [{ pad: 'x'.repeat(MAX_BODY_BYTES) }] });
    assert.equal((await post(baseUrl, huge)).status, 413);
  });
});

test('a storage failure answers 503, logs once, and does not throw into the app', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vd-capture-broken-'));
  const blocker = path.join(dir, 'not-a-dir');
  writeFileSync(blocker, 'file where a directory should be');
  try {
    await withServer({ dbPath: path.join(blocker, 'flows.db') }, async (baseUrl, _config, lines) => {
      assert.equal((await post(baseUrl, goodBatch)).status, 503);
      assert.equal((await post(baseUrl, goodBatch)).status, 503);
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.match(lines[0], /capture paused, app unaffected/);
      // The rest of the app is still served.
      const recorder = await fetch(`${baseUrl}/vd-recorder.js`);
      assert.equal(recorder.status, 200);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rate limit answers 429 past the per-minute batch budget', async () => {
  await withServer({ maxBatchesPerMinute: 2 }, async (baseUrl) => {
    assert.equal((await post(baseUrl, goodBatch)).status, 204);
    assert.equal((await post(baseUrl, goodBatch)).status, 204);
    assert.equal((await post(baseUrl, goodBatch)).status, 429);
  });
});

test('enabled: the recorder URL falls through to the static file', async () => {
  await withServer({}, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/vd-recorder.js`)).text();
    assert.equal(body, '/* real recorder */');
  });
});

test('disabled: no-op recorder script, endpoint stores nothing and creates no db', async () => {
  await withServer({ enabled: false }, async (baseUrl, config) => {
    const recorder = await fetch(`${baseUrl}/vd-recorder.js`);
    assert.equal(recorder.status, 200);
    assert.match(await recorder.text(), /capture disabled/);
    assert.equal((await post(baseUrl, goodBatch)).status, 204);
    assert.equal(existsSync(config.dbPath), false);
  });
});

test('resolveVdebugCaptureConfig: defaults beside DATABASE_PATH, env overrides, disable flag', () => {
  const base = resolveVdebugCaptureConfig({ DATABASE_PATH: '/var/lib/cloudcli/auth.db' });
  assert.deepEqual(
    { enabled: base.enabled, dbPath: base.dbPath, retentionDays: base.retentionDays },
    { enabled: true, dbPath: '/var/lib/cloudcli/flows.db', retentionDays: 30 },
  );
  const custom = resolveVdebugCaptureConfig({
    DATABASE_PATH: '/x/auth.db',
    VD_FLOWS_DB: '/state/flows.db',
    VD_CAPTURE_RETENTION_DAYS: '7',
  });
  assert.equal(custom.dbPath, '/state/flows.db');
  assert.equal(custom.retentionDays, 7);
  for (const off of ['false', 'FALSE', '0', 'off', 'no']) {
    assert.equal(resolveVdebugCaptureConfig({ VD_CAPTURE_ENABLED: off }).enabled, false, off);
  }
  assert.equal(resolveVdebugCaptureConfig({ VD_CAPTURE_ENABLED: 'true' }).enabled, true);
  for (const bad of ['-3', '0', 'abc', '']) {
    assert.equal(resolveVdebugCaptureConfig({ VD_CAPTURE_RETENTION_DAYS: bad }).retentionDays, 30, bad);
  }
  assert.match(resolveVdebugCaptureConfig({}).dbPath, /\.cloudcli[\\/]flows\.db$/);
});

/** Drives the router directly with an injected clock, no HTTP server. */
async function withClockRouter(
  config: VdebugCaptureConfig,
  fn: (call: (body: string) => Promise<number>, clock: { t: number }, lines: string[]) => Promise<void>,
) {
  const clock = { t: 1_000_000 };
  const { lines, logger } = quietLogger();
  const app = express();
  app.use(createVdebugCaptureRouter(config, { logger, now: () => clock.t }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn((body) => post(`http://127.0.0.1:${port}`, body).then((r) => r.status), clock, lines);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('a failed db open is retried after the backoff, and capture resumes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vd-capture-retry-'));
  const blocker = path.join(dir, 'state');
  writeFileSync(blocker, 'a file where the state dir should be');
  const config: VdebugCaptureConfig = {
    enabled: true, dbPath: path.join(blocker, 'flows.db'), retentionDays: 30, maxBatchesPerMinute: 300,
  };
  try {
    await withClockRouter(config, async (call, clock) => {
      assert.equal(await call(goodBatch), 503);
      rmSync(blocker); // the operator fixes the state path
      assert.equal(await call(goodBatch), 503, 'still inside the backoff window');
      clock.t += 61_000;
      assert.equal(await call(goodBatch), 204, 'reopened after the backoff');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retention prune runs at most daily from the request path', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vd-capture-prune-'));
  const config: VdebugCaptureConfig = {
    enabled: true, dbPath: path.join(dir, 'flows.db'), retentionDays: 30, maxBatchesPerMinute: 10_000,
  };
  const staleBatch = JSON.stringify({ session_id: 'stalesession1', events: [{ seq: 0, t: 0, type: 'click' }] });
  const count = () => {
    const store = new FlowStore(config.dbPath);
    try {
      return (store.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'stalesession1'").get() as { n: number }).n;
    } finally {
      store.close();
    }
  };
  const ageStale = () => {
    const store = new FlowStore(config.dbPath);
    try {
      store.db.prepare("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00+00:00' WHERE id = 'stalesession1'").run();
    } finally {
      store.close();
    }
  };
  try {
    await withClockRouter(config, async (call, clock) => {
      await new Promise((resolve) => setImmediate(resolve)); // startup prune has run
      assert.equal(await call(staleBatch), 204);
      ageStale();
      assert.equal(await call(goodBatch), 204);
      assert.equal(count(), 1, 'no second prune within the same day');
      clock.t += 86_400_000 + 1;
      assert.equal(await call(goodBatch), 204);
      assert.equal(count(), 0, 'pruned once a day has passed');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rate-limit hits are logged once per window and startup logs the db path', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vd-capture-log-'));
  const infos: string[] = [];
  const warns: string[] = [];
  const app = express();
  app.use(createVdebugCaptureRouter(
    { enabled: true, dbPath: path.join(dir, 'flows.db'), retentionDays: 30, maxBatchesPerMinute: 1 },
    { logger: { warn: (m: string) => warns.push(m), info: (m: string) => infos.push(m) } },
  ));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await post(base, goodBatch)).status, 204);
    assert.equal((await post(base, goodBatch)).status, 429);
    assert.equal((await post(base, goodBatch)).status, 429);
    assert.equal(warns.filter((w) => w.includes('rate limit')).length, 1);
    assert.equal(infos.length, 1);
    assert.match(infos[0], /enabled: db=.*flows\.db, retention=30d/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
