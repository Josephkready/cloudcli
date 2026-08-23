import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { forgetSeenClientMessages } from '@/modules/websocket/services/chat-send-dedupe.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * `chat_send_accepted` — the delivery acknowledgement (#389).
 *
 * WHY THIS MATTERS. A `chat.send` that arrives while a run is already in flight
 * is appended to the server-side FIFO and used to be answered with NOTHING. The
 * client's only evidence of delivery was a transcript echo, which for a queued
 * message does not appear until the run ahead of it finishes — often far beyond
 * the client's 30s resend grace. So the client resent a message the server
 * already held, and the user was asked the same thing twice.
 *
 * The queued-path test below is the real regression guard: an ack on the
 * start path alone would leave the duplicate bug exactly where it was.
 */

/** Minimal socket: an EventEmitter that records the JSON frames sent to it. */
class FakeSocket extends EventEmitter {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  framesOfKind(kind: string): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.kind === kind);
  }

  acks(): Array<Record<string, unknown>> {
    return this.framesOfKind('chat_send_accepted');
  }
}

type SpawnCall = {
  command: string;
  writer: { send: (message: Record<string, unknown>) => void };
  resolve: () => void;
};

/** A provider runtime whose runs finish only when the test says so. */
function makeControllableSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, _options: unknown, writer: unknown): Promise<void> =>
    new Promise<void>((resolve) => {
      calls.push({ command, writer: writer as SpawnCall['writer'], resolve });
    });
  return { spawn, calls };
}

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

function sendChat(
  socket: FakeSocket,
  sessionId: string,
  content: string,
  clientMessageId?: string,
): void {
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId,
    content,
    ...(clientMessageId ? { clientMessageId } : {}),
  }));
}

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-ws-ack-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    forgetSeenClientMessages();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('a send that starts a run is acknowledged with its client message id', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('ack-start', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    sendChat(socket, 'ack-start', 'hello', 'pending_1');
    await settle();

    const acks = socket.acks();
    assert.equal(acks.length, 1);
    assert.equal(acks[0]?.clientMessageId, 'pending_1');
    assert.equal(acks[0]?.sessionId, 'ack-start');

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

test('a QUEUED send is acknowledged too, without waiting for the run ahead of it', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('ack-queued', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    sendChat(socket, 'ack-queued', 'first', 'pending_1');
    await settle();
    assert.equal(calls.length, 1, 'the first send starts a run');

    // This one lands while the run above is still live, so it is queued.
    sendChat(socket, 'ack-queued', 'second', 'pending_2');
    await settle();

    assert.equal(calls.length, 1, 'still only one run — the second message is queued');
    assert.equal(chatRunRegistry.getPendingCount('ack-queued'), 1);

    // The heart of #389: the queued message is acknowledged NOW, while the run
    // ahead of it is unfinished and its transcript row does not exist yet.
    const ackedIds = socket.acks().map((frame) => frame.clientMessageId);
    assert.deepEqual(ackedIds, ['pending_1', 'pending_2']);
    assert.equal(socket.framesOfKind('protocol_error').length, 0);

    finishRun(calls[0] as SpawnCall);
    await settle();
    finishRun(calls[1] as SpawnCall);
    await settle();
  });
});

test('every message in a burst is acknowledged, so none is left looking undelivered', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('ack-burst', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    // The shape a reconnect drain produces: everything typed during an outage
    // goes out at once.
    sendChat(socket, 'ack-burst', 'one', 'pending_1');
    sendChat(socket, 'ack-burst', 'two', 'pending_2');
    sendChat(socket, 'ack-burst', 'three', 'pending_3');
    await settle();

    assert.deepEqual(
      socket.acks().map((frame) => frame.clientMessageId),
      ['pending_1', 'pending_2', 'pending_3'],
    );

    for (const call of [...calls]) {
      finishRun(call);
      await settle();
    }
  });
});

test('a send with no client message id is accepted but not acknowledged', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('ack-legacy', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    // An older client that predates the ack. It must still run — an ack it
    // cannot correlate is not worth failing the send over.
    sendChat(socket, 'ack-legacy', 'hello');
    await settle();

    assert.equal(calls.length, 1, 'the message must still run');
    assert.equal(socket.acks().length, 0);
    assert.equal(socket.framesOfKind('protocol_error').length, 0);

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

test('a rejected send is NOT acknowledged (an unknown session must stay resendable)', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    sendChat(socket, 'no-such-session', 'hello', 'pending_1');
    await settle();

    assert.equal(socket.acks().length, 0, 'acking a failed send would discard the only copy');
    assert.equal(socket.framesOfKind('protocol_error').length, 1);
  });
});

test('chat.ping is answered with pong and touches no session state', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    socket.emit('message', JSON.stringify({ type: 'chat.ping' }));
    await settle();

    assert.equal(socket.framesOfKind('pong').length, 1);
    assert.equal(socket.framesOfKind('protocol_error').length, 0);
  });
});

test('a resent message with a known id is re-acked, NOT run a second time', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('dedupe', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    sendChat(socket, 'dedupe', 'only once', 'pending_1');
    await settle();
    assert.equal(calls.length, 1);

    // The ack never reached the client (a half-open socket whose uplink works
    // and whose downlink is dead), so the client retries the same entry. The
    // server already has it — running it again is the #389 duplicate.
    sendChat(socket, 'dedupe', 'only once', 'pending_1');
    await settle();

    assert.equal(calls.length, 1, 'the message must not run twice');
    assert.equal(
      socket.acks().filter((frame) => frame.clientMessageId === 'pending_1').length,
      2,
      'the retry is answered, so the client can finally retire its entry',
    );

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

test('a resend is suppressed even while the original is still queued', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('dedupe-queued', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    sendChat(socket, 'dedupe-queued', 'first', 'pending_1');
    await settle();
    sendChat(socket, 'dedupe-queued', 'second', 'pending_2');
    await settle();
    assert.equal(chatRunRegistry.getPendingCount('dedupe-queued'), 1);

    // The window the ack alone could not close: the queued message has no
    // transcript row yet, so a client past its 30s grace resends it.
    sendChat(socket, 'dedupe-queued', 'second', 'pending_2');
    await settle();

    assert.equal(
      chatRunRegistry.getPendingCount('dedupe-queued'),
      1,
      'the resend must not add a second copy to the FIFO',
    );

    finishRun(calls[0] as SpawnCall);
    await settle();
    finishRun(calls[1] as SpawnCall);
    await settle();
    assert.deepEqual(calls.map((call) => call.command), ['first', 'second']);
  });
});

test('distinct ids with identical text both run — dedup is by id, not content', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('dedupe-text', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    // Deliberately asking the same thing twice is a legitimate thing to do.
    sendChat(socket, 'dedupe-text', 'again please', 'pending_1');
    await settle();
    sendChat(socket, 'dedupe-text', 'again please', 'pending_2');
    await settle();

    finishRun(calls[0] as SpawnCall);
    await settle();

    assert.equal(calls.length, 2, 'a genuinely new message must not be swallowed');
  });
});

test('the same id in a DIFFERENT session is not treated as a duplicate', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('sess-a', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('sess-b', 'claude', '/workspace/demo');
    const { spawn, calls } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    // Ids are only unique within one client's storage, so they can collide
    // across sessions.
    sendChat(socket, 'sess-a', 'hello a', 'pending_1');
    await settle();
    sendChat(socket, 'sess-b', 'hello b', 'pending_1');
    await settle();

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.command), ['hello a', 'hello b']);

    for (const call of [...calls]) {
      finishRun(call);
      await settle();
    }
  });
});

test('a send rejected for an unknown session stays retryable (its id is not burned)', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    // Rejected: the session does not exist yet.
    sendChat(socket, 'later-session', 'hello', 'pending_1');
    await settle();
    assert.equal(socket.framesOfKind('protocol_error').length, 1);

    // The client creates the session and retries the SAME entry. If the
    // rejection had recorded the id, this would be swallowed as a duplicate and
    // falsely acked — losing the only copy of the message.
    sessionsDb.createAppSession('later-session', 'claude', '/workspace/demo');
    sendChat(socket, 'later-session', 'hello', 'pending_1');
    await settle();

    assert.equal(calls.length, 1, 'the retry must actually run');
    assert.equal(socket.acks().length, 1);

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

test('an unknown message type reports which type it rejected', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const socket = new FakeSocket();
    connect(socket, makeDependencies(spawn));

    socket.emit('message', JSON.stringify({ type: 'chat.nonsense' }));
    await settle();

    const [error] = socket.framesOfKind('protocol_error');
    assert.equal(error?.code, 'UNKNOWN_MESSAGE_TYPE');
    // Carrying the type is what lets a NEWER client recognise an old server's
    // rejection of its liveness probe and swallow it instead of rendering it as
    // a chat error (#389).
    assert.equal(error?.type, 'chat.nonsense');
  });
});
