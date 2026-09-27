import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';

import pty from 'node-pty';
import { WebSocket } from 'ws';

import { handleShellConnection } from './shell-websocket.service.js';

// Drives handleShellConnection, the biggest uncovered chunk of
// shell-websocket.service.ts. node-pty's default export is a plain
// CJS-interop object (not a real ESM named export), so — unlike the Claude/
// Codex SDKs — `pty.spawn` can just be monkeypatched directly; verified this
// works without any mock.module machinery. Still run under
// --experimental-test-module-mocks (harmless) since it's on for the whole
// server:test script now.

class FakePty extends EventEmitter {
  written: string[] = [];
  resized: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataHandlers: Array<(chunk: string) => void> = [];
  private exitHandlers: Array<(e: { exitCode: number; signal?: number }) => void> = [];

  onData(handler: (chunk: string) => void) { this.dataHandlers.push(handler); }
  onExit(handler: (e: { exitCode: number; signal?: number }) => void) { this.exitHandlers.push(handler); }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.resized.push({ cols, rows }); }
  kill() { this.killed = true; }

  emitData(chunk: string) { this.dataHandlers.forEach((h) => h(chunk)); }
  emitExit(exitCode: number, signal?: number) { this.exitHandlers.forEach((h) => h({ exitCode, signal })); }
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: any[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    resolveProviderSessionId: () => null,
    stripAnsiSequences: (content: string) => content,
    normalizeDetectedUrl: () => null,
    extractUrlsFromText: () => [],
    shouldAutoOpenUrlFromOutput: () => false,
    ...overrides,
  } as any;
}

let lastSpawnedPty: FakePty | null = null;
let lastSpawnArgs: any = null;
const originalSpawn = pty.spawn;

test.before(() => {
  (pty as any).spawn = (shell: string, args: string[], opts: any) => {
    lastSpawnArgs = { shell, args, opts };
    lastSpawnedPty = new FakePty();
    return lastSpawnedPty;
  };
  // detachPtySessionSocket (fired on the 'close' handler) schedules a REAL
  // 30-minute setTimeout to eventually kill an orphaned pty — not unref'd,
  // since in production that's exactly what should keep the process alive.
  // Fake timers here so that grace-period timer never becomes a real OS
  // timer holding this test file's process open for 30 minutes.
  mock.timers.enable({ apis: ['setTimeout'] });
});

test.after(() => {
  (pty as any).spawn = originalSpawn;
  mock.timers.reset();
});

async function withProjectDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join('/var/tmp', 'shell-ws-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('handleShellConnection: init spawns a pty, sends a welcome message, and streams output back', async () => {
  await withProjectDir(async (projectPath) => {
    const ws = new FakeSocket();
    handleShellConnection(ws as any, makeDeps());

    ws.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: false, isPlainShell: true, initialCommand: 'echo hi' }));
    await flush();

    assert.ok(lastSpawnArgs, 'expected pty.spawn to have been called');
    assert.ok(ws.sent.some((m) => m.type === 'output' && m.data.includes('Starting terminal in')));

    lastSpawnedPty!.emitData('hello from pty\r\n');
    const outputFrame = ws.sent.find((m) => m.type === 'output' && m.data === 'hello from pty\r\n');
    assert.ok(outputFrame, 'expected the pty output chunk to be forwarded to the socket');
  });
});

test('handleShellConnection: an invalid project path replies with an error and never spawns', async () => {
  const ws = new FakeSocket();
  handleShellConnection(ws as any, makeDeps());
  lastSpawnArgs = null;

  ws.emit('message', JSON.stringify({ type: 'init', projectPath: '/definitely/does/not/exist/at/all', hasSession: false }));
  await flush();

  assert.equal(lastSpawnArgs, null);
  assert.ok(ws.sent.some((m) => m.type === 'error' && m.message === 'Invalid project path'));
});

test('handleShellConnection: an unsafe session id is rejected before spawning', async () => {
  await withProjectDir(async (projectPath) => {
    const ws = new FakeSocket();
    handleShellConnection(ws as any, makeDeps());
    lastSpawnArgs = null;

    ws.emit('message', JSON.stringify({ type: 'init', projectPath, sessionId: 'bad; rm -rf /', hasSession: true }));
    await flush();

    assert.equal(lastSpawnArgs, null);
    assert.ok(ws.sent.some((m) => m.type === 'error' && m.message === 'Invalid session ID'));
  });
});

test('handleShellConnection: reconnecting to an existing session replays its buffer instead of respawning', async () => {
  await withProjectDir(async (projectPath) => {
    const ws1 = new FakeSocket();
    handleShellConnection(ws1 as any, makeDeps());
    ws1.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: false, isPlainShell: true, initialCommand: 'echo hi' }));
    await flush();
    const firstPty = lastSpawnedPty!;
    firstPty.emitData('buffered output\r\n');

    const ws2 = new FakeSocket();
    handleShellConnection(ws2 as any, makeDeps());
    lastSpawnArgs = null;
    ws2.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: false, isPlainShell: true, initialCommand: 'echo hi' }));
    await flush();

    assert.equal(lastSpawnArgs, null, 'a matching session key must reuse the pty, not spawn a new one');
    assert.ok(ws2.sent.some((m) => m.type === 'output' && m.data.includes('Reconnected to existing session')));
    assert.ok(ws2.sent.some((m) => m.type === 'output' && m.data === 'buffered output\r\n'));
  });
});

test('handleShellConnection: forceRestart kills the old pty and spawns a fresh one for the same key', async () => {
  await withProjectDir(async (projectPath) => {
    const ws1 = new FakeSocket();
    handleShellConnection(ws1 as any, makeDeps());
    ws1.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: false, isPlainShell: true, initialCommand: 'echo hi' }));
    await flush();
    const firstPty = lastSpawnedPty!;

    ws1.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: false, isPlainShell: true, initialCommand: 'echo hi', forceRestart: true }));
    await flush();

    assert.equal(firstPty.killed, true);
    assert.notEqual(lastSpawnedPty, firstPty);
  });
});

test('handleShellConnection: input is written to the active pty and resize forwards cols/rows', async () => {
  await withProjectDir(async (projectPath) => {
    const ws = new FakeSocket();
    handleShellConnection(ws as any, makeDeps());
    ws.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: false, isPlainShell: true, initialCommand: 'echo hi' }));
    await flush();

    ws.emit('message', JSON.stringify({ type: 'input', data: 'ls -la\n' }));
    await flush();
    assert.ok(lastSpawnedPty!.written.includes('ls -la\n'));

    ws.emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await flush();
    assert.deepEqual(lastSpawnedPty!.resized.at(-1), { cols: 120, rows: 40 });
  });
});

test('handleShellConnection: an unparseable message is reported as an error frame, not a crash', async () => {
  const ws = new FakeSocket();
  handleShellConnection(ws as any, makeDeps());
  ws.emit('message', Buffer.from('not json'));
  await flush();
  assert.ok(ws.sent.some((m) => m.type === 'output' && m.data.includes('Error:')));
});

test('handleShellConnection: pty exit notifies the socket and clears the session', async () => {
  await withProjectDir(async (projectPath) => {
    const ws = new FakeSocket();
    handleShellConnection(ws as any, makeDeps());
    ws.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: false, isPlainShell: true, initialCommand: 'echo hi' }));
    await flush();

    lastSpawnedPty!.emitExit(1, undefined);
    assert.ok(ws.sent.some((m) => m.type === 'output' && m.data.includes('Process exited with code 1')));

    // A second 'input' after exit must not throw even though shellProcess
    // is now cleared internally.
    ws.emit('message', JSON.stringify({ type: 'input', data: 'ignored' }));
    await flush();
  });
});

test('handleShellConnection: close detaches the socket from its pty session (does not kill it immediately)', async () => {
  await withProjectDir(async (projectPath) => {
    const ws = new FakeSocket();
    handleShellConnection(ws as any, makeDeps());
    ws.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: false, isPlainShell: true, initialCommand: 'echo hi' }));
    await flush();

    const spawnedPty = lastSpawnedPty!;
    ws.emit('close');
    assert.equal(spawnedPty.killed, false, 'closing the socket must not immediately kill the pty (grace period)');
  });
});

test('handleShellConnection: a claude session with a resumable id announces resuming in the welcome message', async () => {
  await withProjectDir(async (projectPath) => {
    const ws = new FakeSocket();
    handleShellConnection(ws as any, makeDeps({ resolveProviderSessionId: () => 'provider-session-id' }));
    ws.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: true, sessionId: 'app-session-id', provider: 'claude' }));
    await flush();

    assert.ok(ws.sent.some((m) => m.type === 'output' && m.data.includes('Resuming Claude session provider-session-id')));
  });
});

test('handleShellConnection: an auth URL detected in output is announced once, deduped across chunks', async () => {
  await withProjectDir(async (projectPath) => {
    const ws = new FakeSocket();
    handleShellConnection(
      ws as any,
      makeDeps({
        extractUrlsFromText: (text: string) => (text.includes('http') ? ['https://example.com/auth'] : []),
        normalizeDetectedUrl: (url: string) => url,
      }),
    );
    ws.emit('message', JSON.stringify({ type: 'init', projectPath, hasSession: false, isPlainShell: true, initialCommand: 'echo hi' }));
    await flush();

    lastSpawnedPty!.emitData('visit http://example.com/auth to log in\r\n');
    lastSpawnedPty!.emitData('still here, http://example.com/auth again\r\n');

    const authFrames = ws.sent.filter((m) => m.type === 'auth_url');
    assert.equal(authFrames.length, 1, 'the same normalized URL must only be announced once');
    assert.equal(authFrames[0].url, 'https://example.com/auth');
  });
});
