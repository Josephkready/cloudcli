import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { startBenchServer } from './server.js';

/*
 * startBenchServer runs `<repoRoot>/node_modules/.bin/tsx ... server/index.js`. These tests point
 * repoRoot at a temp dir whose `tsx` is a tiny fake: never the real server, so nothing here can
 * collide with a live cloudcli. The fixture HOME is seeded for real (profile small).
 */

/** A fake repoRoot whose `tsx` records its pid, then either serves the few endpoints startup
 *  needs on SERVER_PORT or (healthy=false) never listens, so startup sits in its health wait. */
function fakeRepo(healthy: boolean): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bench-server-test-'));
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
  writeFileSync(tsx, `#!/usr/bin/env node
require('node:fs').writeFileSync('pid', String(process.pid));
if (${healthy}) {
  require('node:http').createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/api/projects' ? JSON.stringify(Array.from({ length: 100 }, (_, i) => i)) : '{}');
  }).listen(Number(process.env.SERVER_PORT), process.env.HOST);
} else {
  setInterval(() => {}, 1 << 30);
}
`);
  chmodSync(tsx, 0o755);
  return root;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('startBenchServer', () => {
  it('binds the fixed port it is given', async () => {
    const port = await freePort();
    const server = await startBenchServer({ repoRoot: fakeRepo(true), profile: 'small', port });
    try {
      assert.equal(server.port, port);
      assert.equal(server.baseURL, `http://127.0.0.1:${port}`);
      assert.ok((await fetch(`${server.baseURL}/health`)).ok);
    } finally {
      await server.stop();
    }
    assert.equal(existsSync(server.home), false, 'stop() deletes the fixture HOME');
  });

  it('probes for a free port when none is given', async () => {
    const server = await startBenchServer({ repoRoot: fakeRepo(true), profile: 'small' });
    try {
      assert.ok(server.port > 0);
      assert.ok((await fetch(`${server.baseURL}/health`)).ok, 'the server is on the probed port');
    } finally {
      await server.stop();
    }
  });

  it('an abort mid-startup kills the server and deletes the HOME', async () => {
    const repoRoot = fakeRepo(false);
    const controller = new AbortController();
    let home = '';
    const starting = startBenchServer({
      repoRoot,
      profile: 'small',
      signal: controller.signal,
      onProgress: (message) => {
        home = /seeding fixture in (\S+)/.exec(message)?.[1] ?? home;
      },
    });
    const pidFile = path.join(repoRoot, 'pid');
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 'the server to spawn');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(home !== '' && existsSync(home));

    controller.abort();
    assert.equal(existsSync(home), false, 'HOME is gone as soon as abort() returns');
    await assert.rejects(starting, { name: 'AbortError' });
    await until(() => !alive(pid), 'the server process to die');
  });

  it('an already-aborted signal starts nothing', async () => {
    const repoRoot = fakeRepo(true);
    await assert.rejects(
      startBenchServer({ repoRoot, profile: 'small', signal: AbortSignal.abort() }),
      { name: 'AbortError' },
    );
    assert.equal(existsSync(path.join(repoRoot, 'pid')), false);
  });
});
