import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * End-to-end coverage for the server-side per-session FIFO queue (issue #64):
 * two devices flushing a queued message for the SAME session the instant a run
 * ends must BOTH be delivered, in arrival order — never rejected and dropped.
 *
 * The suite drives the real `chat.send` handler through `handleChatConnection`
 * with controllable fake provider runtimes, so it exercises the actual
 * enqueue/dispatch path, not just the registry primitives.
 */

/** Minimal socket: an EventEmitter that records the JSON frames sent to it. */
class FakeSocket extends EventEmitter {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  protocolErrors(): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.kind === 'protocol_error');
  }
}

type SpawnCall = {
  command: string;
  options: Record<string, unknown>;
  writer: { send: (message: Record<string, unknown>) => void };
  resolve: () => void;
};

/**
 * A provider runtime whose runs never finish on their own — the test decides
 * exactly when each run completes, so the race window can be held open.
 */
function makeControllableSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, options: unknown, writer: unknown): Promise<void> =>
    new Promise<void>((resolve) => {
      calls.push({
        command,
        options: (options ?? {}) as Record<string, unknown>,
        writer: writer as SpawnCall['writer'],
        resolve,
      });
    });
  return { spawn, calls };
}

/** Emits the terminal `complete` for a run, then resolves its runtime promise. */
function finishRun(call: SpawnCall): void {
  call.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
  call.resolve();
}

function makeDependencies(spawn: ReturnType<typeof makeControllableSpawn>['spawn']) {
  return {
    spawnFns: { claude: spawn, codex: spawn },
    abortFns: { claude: () => true, codex: () => true },
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  } as unknown as Parameters<typeof handleChatConnection>[2];
}

const request = { user: { id: 'tester' } } as unknown as Parameters<typeof handleChatConnection>[1];

function connect(
  socket: FakeSocket,
  dependencies: Parameters<typeof handleChatConnection>[2],
): void {
  handleChatConnection(socket as unknown as Parameters<typeof handleChatConnection>[0], request, dependencies);
}

function sendChat(socket: FakeSocket, sessionId: string, content: string): void {
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId, content }));
}

/** Flush pending microtasks + timers so the async dispatch loop can advance. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-ws-queue-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('two devices queueing the same session are both delivered in FIFO order (none dropped)', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('race-session', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const dependencies = makeDependencies(spawn);

    const deviceA = new FakeSocket();
    const deviceB = new FakeSocket();
    connect(deviceA, dependencies);
    connect(deviceB, dependencies);

    // Both devices flush the instant the previous turn ends. Device A's send
    // reaches the server first and starts the run; device B's arrives while
    // that run is live.
    sendChat(deviceA, 'race-session', 'message-A');
    sendChat(deviceB, 'race-session', 'message-B');
    await settle();

    // Only run A started; B is safely queued server-side, NOT rejected.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'message-A');
    assert.equal(chatRunRegistry.getPendingCount('race-session'), 1);
    assert.equal(chatRunRegistry.isProcessing('race-session'), true);
    assert.equal(deviceB.protocolErrors().length, 0, 'device B must not receive RUN_IN_PROGRESS');

    // Run A finishes → the server dispatches the queued message B automatically.
    finishRun(calls[0] as SpawnCall);
    await settle();

    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.command, 'message-B');
    assert.equal(chatRunRegistry.getPendingCount('race-session'), 0);
    assert.equal(chatRunRegistry.isProcessing('race-session'), true);

    // Run B finishes → the queue drains and the dispatcher releases.
    finishRun(calls[1] as SpawnCall);
    await settle();

    // Both messages ran, in order, with no drops and no protocol errors.
    assert.deepEqual(calls.map((call) => call.command), ['message-A', 'message-B']);
    assert.equal(chatRunRegistry.isProcessing('race-session'), false);
    assert.equal(chatRunRegistry.isDispatching('race-session'), false);
    assert.equal(deviceA.protocolErrors().length, 0);
    assert.equal(deviceB.protocolErrors().length, 0);
  });
});

test('three concurrent queued sends all deliver in FIFO order', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('fifo-session', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const dependencies = makeDependencies(spawn);

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'fifo-session', 'first');
    sendChat(socket, 'fifo-session', 'second');
    sendChat(socket, 'fifo-session', 'third');
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(chatRunRegistry.getPendingCount('fifo-session'), 2);

    finishRun(calls[0] as SpawnCall);
    await settle();
    finishRun(calls[1] as SpawnCall);
    await settle();
    finishRun(calls[2] as SpawnCall);
    await settle();

    assert.deepEqual(calls.map((call) => call.command), ['first', 'second', 'third']);
    assert.equal(chatRunRegistry.isProcessing('fifo-session'), false);
    assert.equal(chatRunRegistry.isDispatching('fifo-session'), false);
    assert.equal(socket.protocolErrors().length, 0);
  });
});

test('normal single-message send starts exactly one run and one complete (no regression)', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('solo-session', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const dependencies = makeDependencies(spawn);

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'solo-session', 'just one');
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'just one');
    assert.equal(chatRunRegistry.getPendingCount('solo-session'), 0);
    assert.equal(chatRunRegistry.isProcessing('solo-session'), true);

    finishRun(calls[0] as SpawnCall);
    await settle();

    assert.equal(calls.length, 1, 'no phantom second run');
    assert.equal(chatRunRegistry.isProcessing('solo-session'), false);
    assert.equal(chatRunRegistry.isDispatching('solo-session'), false);
    assert.equal(socket.protocolErrors().length, 0);
    assert.equal(
      socket.frames.filter((frame) => frame.kind === 'complete').length,
      1,
      'exactly one terminal complete',
    );
  });
});

test('a follow-up sent after the previous run fully completed starts a fresh run', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('sequential-session', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const dependencies = makeDependencies(spawn);

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'sequential-session', 'one');
    await settle();
    finishRun(calls[0] as SpawnCall);
    await settle();

    // The dispatcher has released; a brand-new send must start its own run.
    assert.equal(chatRunRegistry.isDispatching('sequential-session'), false);
    sendChat(socket, 'sequential-session', 'two');
    await settle();

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.command), ['one', 'two']);
    assert.equal(chatRunRegistry.isProcessing('sequential-session'), true);

    finishRun(calls[1] as SpawnCall);
    await settle();
    assert.equal(chatRunRegistry.isProcessing('sequential-session'), false);
    assert.equal(socket.protocolErrors().length, 0);
  });
});
