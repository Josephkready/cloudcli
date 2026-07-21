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
 * Dispatch-layer coverage for the chat websocket handler (issue #105): the
 * `chat.send` / `chat.abort` / `chat.subscribe` / `chat.permission-response`
 * message handlers and the protocol errors around them.
 *
 * Everything runs through the real `handleChatConnection` with fake sockets and
 * fake provider runtimes, so the assertions describe the actual wire protocol a
 * browser sees — not registry internals (those are covered by
 * `chat-run-registry.test.ts`) and not the FIFO queue (`chat-websocket-queue.test.ts`).
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

  framesOfKind(kind: string): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.kind === kind);
  }
}

type SpawnCall = {
  command: string;
  options: Record<string, unknown>;
  writer: {
    send: (message: Record<string, unknown>) => void;
    setSessionId: (id: string) => void;
  };
  resolve: () => void;
  reject: (error: Error) => void;
};

/** A provider runtime whose runs finish only when the test says so. */
function makeControllableSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, options: unknown, writer: unknown): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      calls.push({
        command,
        options: (options ?? {}) as Record<string, unknown>,
        writer: writer as SpawnCall['writer'],
        resolve,
        reject,
      });
    });
  return { spawn, calls };
}

type AbortRecord = { providerSessionId: string };

type DependencyOverrides = {
  spawnFns?: Record<string, unknown>;
  abortFn?: (providerSessionId: string) => boolean | Promise<boolean>;
  resolveToolApproval?: (requestId: string, payload: Record<string, unknown>) => void;
  getPendingApprovalsForSession?: (providerSessionId: string) => unknown[];
};

type Dependencies = Parameters<typeof handleChatConnection>[2];

function makeDependencies(
  spawn: ReturnType<typeof makeControllableSpawn>['spawn'],
  overrides: DependencyOverrides = {},
): { dependencies: Dependencies; aborts: AbortRecord[]; approvalLookups: string[] } {
  const aborts: AbortRecord[] = [];
  const approvalLookups: string[] = [];

  const dependencies = {
    spawnFns: overrides.spawnFns ?? { claude: spawn, codex: spawn },
    abortFns: {
      claude: (providerSessionId: string) => {
        aborts.push({ providerSessionId });
        return overrides.abortFn ? overrides.abortFn(providerSessionId) : true;
      },
      codex: (providerSessionId: string) => {
        aborts.push({ providerSessionId });
        return overrides.abortFn ? overrides.abortFn(providerSessionId) : true;
      },
    },
    resolveToolApproval: overrides.resolveToolApproval ?? (() => {}),
    getPendingApprovalsForSession: (providerSessionId: string) => {
      approvalLookups.push(providerSessionId);
      return overrides.getPendingApprovalsForSession
        ? overrides.getPendingApprovalsForSession(providerSessionId)
        : [];
    },
  } as unknown as Dependencies;

  return { dependencies, aborts, approvalLookups };
}

const request = { user: { id: 'tester' } } as unknown as Parameters<typeof handleChatConnection>[1];

function connect(socket: FakeSocket, dependencies: Dependencies): void {
  handleChatConnection(socket as unknown as Parameters<typeof handleChatConnection>[0], request, dependencies);
}

function emit(socket: FakeSocket, payload: unknown): void {
  socket.emit('message', typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function sendChat(socket: FakeSocket, sessionId: string, content: string, options?: Record<string, unknown>): void {
  emit(socket, { type: 'chat.send', sessionId, content, options });
}

/** Emits the terminal `complete` for a run, then resolves its runtime promise. */
function finishRun(call: SpawnCall): void {
  call.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
  call.resolve();
}

/**
 * Captures `console.warn`/`console.error` for the duration of an expected-error
 * assertion, so the log line does not leak to the suite's stderr (where it reads
 * like a real failure) and so the test can assert it was actually emitted.
 */
function captureConsole(level: 'warn' | 'error'): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = [];
  const original = console[level];
  console[level] = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console[level] = original;
    },
  };
}

/** Flush pending microtasks so the async dispatch loop can advance. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-ws-dispatch-'));
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

// ---------------------------------------------------------------------------
// chat.send — session-row resolution
// ---------------------------------------------------------------------------

test('chat.send without a sessionId is rejected with SESSION_ID_REQUIRED and spawns nothing', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    const socket = new FakeSocket();
    connect(socket, dependencies);

    emit(socket, { type: 'chat.send', content: 'hello' });
    emit(socket, { type: 'chat.send', sessionId: '   ', content: 'hello' });
    emit(socket, { type: 'chat.send', sessionId: 42, content: 'hello' });
    await settle();

    const errors = socket.protocolErrors();
    assert.equal(errors.length, 3, 'blank/whitespace/non-string session ids are all rejected');
    for (const error of errors) {
      assert.equal(error.code, 'SESSION_ID_REQUIRED');
      assert.equal(error.sessionId, null, 'there is no session to echo back');
      assert.equal(typeof error.timestamp, 'string');
    }
    assert.equal(calls.length, 0);
  });
});

test('chat.send for an unknown session is rejected with SESSION_NOT_FOUND', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'ghost-session', 'hello');
    await settle();

    const [error] = socket.protocolErrors();
    assert.equal(error?.code, 'SESSION_NOT_FOUND');
    assert.equal(error?.sessionId, 'ghost-session', 'the offending session id is echoed back');
    assert.match(String(error?.error), /POST \/api\/providers\/sessions/, 'tells the client how to recover');
    assert.equal(calls.length, 0, 'no run is started for a session that does not exist');
    assert.equal(chatRunRegistry.isDispatching('ghost-session'), false);
  });
});

test('chat.send for a provider with no runtime is rejected with UNSUPPORTED_PROVIDER', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    // The session row says `codex`, but only the claude runtime is wired up.
    const { dependencies } = makeDependencies(spawn, { spawnFns: { claude: spawn } });
    sessionsDb.createAppSession('unsupported-session', 'codex', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'unsupported-session', 'hello');
    await settle();

    const [error] = socket.protocolErrors();
    assert.equal(error?.code, 'UNSUPPORTED_PROVIDER');
    assert.equal(error?.sessionId, 'unsupported-session');
    assert.match(String(error?.error), /codex/);
    assert.equal(chatRunRegistry.isProcessing('unsupported-session'), false);
  });
});

test('chat.send resolves provider, cwd and project path from the session row, not the client', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('resolve-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    // A hostile/stale client tries to smuggle its own ids in via options.
    sendChat(socket, 'resolve-session', 'hello', {
      model: 'opus',
      sessionId: 'client-supplied',
      resume: true,
    });
    await settle();

    assert.equal(calls.length, 1);
    const options = calls[0]?.options ?? {};
    assert.equal(calls[0]?.command, 'hello');
    assert.equal(options.model, 'opus', 'client options are passed through');
    assert.equal(options.sessionId, undefined, 'a fresh session has no provider-native id yet');
    assert.equal(options.resume, false, 'the server, not the client, decides whether to resume');
    assert.equal(options.cwd, '/workspace/demo', 'cwd comes from the session row');
    assert.equal(options.projectPath, '/workspace/demo');

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

test('a follow-up send resumes the provider-native id the previous run established', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('resume-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'resume-session', 'first');
    await settle();
    // The runtime announces its native id mid-run; the writer captures it and
    // the registry persists the mapping onto the session row.
    (calls[0] as SpawnCall).writer.send({
      kind: 'session_created',
      provider: 'claude',
      newSessionId: 'native-abc',
    });
    finishRun(calls[0] as SpawnCall);
    await settle();

    assert.equal(sessionsDb.getSessionById('resume-session')?.provider_session_id, 'native-abc');

    sendChat(socket, 'resume-session', 'second');
    await settle();

    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.options.sessionId, 'native-abc', 'the follow-up resumes the same transcript');
    assert.equal(calls[1]?.options.resume, true);

    finishRun(calls[1] as SpawnCall);
    await settle();
  });
});

test('chat.send re-validates image attachments before they reach the runtime', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('image-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    // Only files that live directly in the global upload store survive; the
    // traversal and the absolute path outside the store are dropped server-side
    // even though the client asked for them.
    sendChat(socket, 'image-session', 'look', {
      images: [
        { path: 'uploaded.png' },
        { path: '../../etc/passwd' },
        { path: '/etc/shadow' },
        { path: 'nested/dir.png' },
      ],
    });
    await settle();

    const images = (calls[0]?.options.images ?? []) as Array<Record<string, unknown>>;
    assert.deepEqual(images.map((image) => image.path), ['uploaded.png']);

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

test('a concurrent send is queued, never rejected with a legacy RUN_IN_PROGRESS error', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('busy-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'busy-session', 'first');
    await settle();
    sendChat(socket, 'busy-session', 'second');
    await settle();

    // The old protocol rejected the second send outright (RUN_IN_PROGRESS);
    // today it is absorbed into the per-session FIFO queue instead.
    assert.equal(socket.protocolErrors().length, 0);
    assert.equal(calls.length, 1);
    assert.equal(chatRunRegistry.getPendingCount('busy-session'), 1);

    finishRun(calls[0] as SpawnCall);
    await settle();
    assert.equal(calls[1]?.command, 'second');
    finishRun(calls[1] as SpawnCall);
    await settle();
  });
});

// ---------------------------------------------------------------------------
// chat.send — the `finally` safety net
// ---------------------------------------------------------------------------

test('a runtime that resolves without completing still gets a synthetic complete (exitCode 1)', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('silent-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'silent-session', 'hello');
    await settle();
    assert.equal(chatRunRegistry.isProcessing('silent-session'), true);

    // The runtime resolves without ever emitting its terminal `complete` —
    // without the safety net the session would stay "processing" forever.
    (calls[0] as SpawnCall).resolve();
    await settle();

    const completes = socket.framesOfKind('complete');
    assert.equal(completes.length, 1, 'exactly one terminal complete');
    assert.equal(completes[0]?.exitCode, 1, 'a run that never completed is reported as failed');
    assert.equal(completes[0]?.aborted, false, 'a crash is not an abort');
    assert.equal(completes[0]?.success, false);
    assert.equal(completes[0]?.sessionId, 'silent-session', 'remapped to the app session id');
    assert.equal(chatRunRegistry.isProcessing('silent-session'), false);
    assert.equal(chatRunRegistry.isDispatching('silent-session'), false);
  });
});

test('a runtime that throws is contained: the client gets a complete and the session is not wedged', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('boom-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'boom-session', 'hello');
    await settle();

    const errors = captureConsole('error');
    try {
      (calls[0] as SpawnCall).reject(new Error('runtime exploded'));
      await settle();
    } finally {
      errors.restore();
    }

    assert.equal(errors.calls.length, 1, 'the runtime failure is logged once for operators');
    assert.match(String(errors.calls[0]?.[0]), /Provider runtime "claude" failed/);

    const completes = socket.framesOfKind('complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.exitCode, 1);
    assert.equal(socket.protocolErrors().length, 0, 'a runtime failure is not a protocol error');
    assert.equal(chatRunRegistry.isProcessing('boom-session'), false);
    assert.equal(chatRunRegistry.isDispatching('boom-session'), false);

    // The session is still usable afterwards.
    sendChat(socket, 'boom-session', 'again');
    await settle();
    assert.equal(calls.length, 2);
    finishRun(calls[1] as SpawnCall);
    await settle();
  });
});

test('the safety net does not double-complete a run that ended normally', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('single-complete', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'single-complete', 'hello');
    await settle();
    finishRun(calls[0] as SpawnCall);
    await settle();

    assert.equal(socket.framesOfKind('complete').length, 1);
  });
});

test('a session deleted mid-run ends the run cleanly instead of spawning against it', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('vanish-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'vanish-session', 'head');
    await settle();
    sendChat(socket, 'vanish-session', 'queued');
    await settle();

    assert.equal(sessionsDb.deleteSessionById('vanish-session'), true);
    finishRun(calls[0] as SpawnCall);
    await settle();

    assert.equal(calls.length, 1, 'the queued message is discarded, not spawned');
    assert.equal(chatRunRegistry.isDispatching('vanish-session'), false);
    assert.equal(chatRunRegistry.getPendingCount('vanish-session'), 0);
  });
});

test('a database failure while resolving the run still completes it and releases the dispatcher', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('db-fail', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    // The handler's own pre-flight lookup succeeds; the one inside the dispatch
    // path (which re-reads the row to resolve the provider id) blows up. Only
    // that second read is poisoned — the completion path reads the row again to
    // broadcast the Done state, and failing that too would test two things at
    // once. `lookups` is asserted below so this ordinal coupling cannot rot into
    // a vacuous test.
    const originalGet = sessionsDb.getSessionById;
    let lookups = 0;
    sessionsDb.getSessionById = ((sessionId: string) => {
      lookups += 1;
      if (lookups === 2) {
        throw new Error('database is gone');
      }
      return originalGet.call(sessionsDb, sessionId);
    }) as typeof sessionsDb.getSessionById;

    const errors = captureConsole('error');
    try {
      sendChat(socket, 'db-fail', 'hello');
      await settle();
    } finally {
      errors.restore();
      sessionsDb.getSessionById = originalGet;
    }

    assert.ok(lookups >= 2, 'the dispatch path really did re-read the session row');
    assert.equal(calls.length, 0, 'nothing is spawned when the row cannot be resolved');
    assert.equal(errors.calls.length, 1);
    assert.match(String(errors.calls[0]?.[0]), /Failed to dispatch run/);

    // The client is never left stuck "processing": the finally still completes.
    const completes = socket.framesOfKind('complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.exitCode, 1);
    assert.equal(chatRunRegistry.isProcessing('db-fail'), false);
    assert.equal(chatRunRegistry.isDispatching('db-fail'), false);
  });
});

test('an unexpected failure mid-drain releases the dispatcher instead of wedging the session', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('drain-fail', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'drain-fail', 'head');
    sendChat(socket, 'drain-fail', 'queued');
    await settle();
    assert.equal(chatRunRegistry.getPendingCount('drain-fail'), 1);

    // Simulate a failure in the handoff between two runs (the only place the
    // dispatch loop's outer catch can fire, since driveSingleRun never throws).
    const originalTake = chatRunRegistry.takeNextQueued;
    chatRunRegistry.takeNextQueued = () => {
      throw new Error('registry blew up');
    };

    const errors = captureConsole('error');
    try {
      finishRun(calls[0] as SpawnCall);
      await settle();
    } finally {
      errors.restore();
      chatRunRegistry.takeNextQueued = originalTake;
    }

    assert.equal(errors.calls.length, 1);
    assert.match(String(errors.calls[0]?.[0]), /Dispatch loop failed/);

    // Wedged would mean: dispatcher held forever, every future send absorbed
    // into a queue nobody drains. Instead the session is clean and usable.
    assert.equal(chatRunRegistry.isDispatching('drain-fail'), false);
    assert.equal(chatRunRegistry.getPendingCount('drain-fail'), 0);
    assert.equal(chatRunRegistry.isProcessing('drain-fail'), false);

    sendChat(socket, 'drain-fail', 'after recovery');
    await settle();
    assert.equal(calls.length, 2, 'a later send starts a fresh run');
    finishRun(calls[1] as SpawnCall);
    await settle();
  });
});

// ---------------------------------------------------------------------------
// chat.abort
// ---------------------------------------------------------------------------

test('chat.abort without a sessionId is rejected with SESSION_ID_REQUIRED', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    const socket = new FakeSocket();
    connect(socket, dependencies);

    emit(socket, { type: 'chat.abort' });
    await settle();

    assert.equal(socket.protocolErrors()[0]?.code, 'SESSION_ID_REQUIRED');
  });
});

test('chat.abort with no active run is rejected with NO_ACTIVE_RUN', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies, aborts } = makeDependencies(spawn);
    sessionsDb.createAppSession('idle-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    // (1) A session that never ran, and (2) an unknown session id both report
    // NO_ACTIVE_RUN — the registry, not the session table, is the source of truth.
    emit(socket, { type: 'chat.abort', sessionId: 'idle-session' });
    emit(socket, { type: 'chat.abort', sessionId: 'never-existed' });
    await settle();

    assert.deepEqual(socket.protocolErrors().map((frame) => frame.code), ['NO_ACTIVE_RUN', 'NO_ACTIVE_RUN']);
    assert.deepEqual(
      socket.protocolErrors().map((frame) => frame.sessionId),
      ['idle-session', 'never-existed'],
    );
    assert.equal(aborts.length, 0, 'no provider abort is attempted');

    // (3) A run that already completed is also "no active run": the completed
    // run lingers in the registry for replay but must not be abortable.
    sendChat(socket, 'idle-session', 'hello');
    await settle();
    finishRun(calls[0] as SpawnCall);
    await settle();

    emit(socket, { type: 'chat.abort', sessionId: 'idle-session' });
    await settle();
    assert.equal(socket.protocolErrors().length, 3);
    assert.equal(socket.protocolErrors()[2]?.code, 'NO_ACTIVE_RUN');
    assert.equal(aborts.length, 0);
  });
});

test('chat.abort cancels the live run via the provider-native id and emits the terminal complete', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies, aborts } = makeDependencies(spawn);
    sessionsDb.createAppSession('abort-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'abort-session', 'long running');
    await settle();
    (calls[0] as SpawnCall).writer.send({
      kind: 'session_created',
      provider: 'claude',
      newSessionId: 'native-abort',
    });
    await settle();

    emit(socket, { type: 'chat.abort', sessionId: 'abort-session' });
    await settle();

    assert.deepEqual(aborts, [{ providerSessionId: 'native-abort' }], 'runtimes are addressed by native id');
    const completes = socket.framesOfKind('complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
    assert.equal(completes[0]?.exitCode, 0, 'a successful abort exits 0');
    assert.equal(completes[0]?.success, false, 'an abort is never a success, even at exitCode 0');
    assert.equal(completes[0]?.sessionId, 'abort-session');
    assert.equal(chatRunRegistry.isProcessing('abort-session'), false);

    // The killed runtime's own late `complete` is dropped (exactly-one contract).
    finishRun(calls[0] as SpawnCall);
    await settle();
    assert.equal(socket.framesOfKind('complete').length, 1);
  });
});

test('an abort the runtime refuses still completes the run, reported as exitCode 1', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn, { abortFn: () => false });
    sessionsDb.createAppSession('stubborn-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'stubborn-session', 'hello');
    await settle();
    (calls[0] as SpawnCall).writer.setSessionId('native-stubborn');

    emit(socket, { type: 'chat.abort', sessionId: 'stubborn-session' });
    await settle();

    const completes = socket.framesOfKind('complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
    assert.equal(completes[0]?.exitCode, 1);
  });
});

test('aborting a run with no provider id yet skips the runtime but still completes the run', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies, aborts } = makeDependencies(spawn);
    sessionsDb.createAppSession('early-abort', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    // The user hits stop before the runtime announced its native id: there is
    // nothing to address, but the client must not be left "processing".
    sendChat(socket, 'early-abort', 'hello');
    await settle();
    emit(socket, { type: 'chat.abort', sessionId: 'early-abort' });
    await settle();

    assert.equal(aborts.length, 0, 'no runtime call without a provider-native id');
    const completes = socket.framesOfKind('complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
    assert.equal(completes[0]?.exitCode, 1);
    assert.equal(chatRunRegistry.isProcessing('early-abort'), false);

    (calls[0] as SpawnCall).resolve();
    await settle();
  });
});

test('a slow abort that resolves after the next queued run started does not kill that newer run', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    // The Claude abort is async: the handler awaits it, and a queued message can
    // start the session's NEXT run inside that await window.
    let releaseAbort: (value: boolean) => void = () => {};
    const abortGate = new Promise<boolean>((resolve) => {
      releaseAbort = resolve;
    });
    const { dependencies } = makeDependencies(spawn, { abortFn: () => abortGate });
    sessionsDb.createAppSession('abort-race', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    sendChat(socket, 'abort-race', 'first');
    await settle();
    (calls[0] as SpawnCall).writer.setSessionId('native-race');
    sendChat(socket, 'abort-race', 'queued follow-up');
    await settle();

    // Abort starts and parks on the runtime's promise.
    emit(socket, { type: 'chat.abort', sessionId: 'abort-race' });
    await settle();

    // Meanwhile the aborted run ends and the dispatcher starts the queued
    // message as a brand-new run.
    finishRun(calls[0] as SpawnCall);
    await settle();
    assert.equal(calls.length, 2, 'the queued follow-up is now running');
    assert.equal(chatRunRegistry.isProcessing('abort-race'), true);

    // Only the first run's own terminal complete reached the client — the abort
    // resolved too late to contribute one.
    const beforeRelease = socket.framesOfKind('complete');
    assert.equal(beforeRelease.length, 1);
    assert.equal(beforeRelease[0]?.exitCode, 0, 'the runtime\'s own complete won, not the abort\'s');
    assert.equal(beforeRelease[0]?.aborted, undefined);

    // Now the stale abort resolves. It must not guillotine the newer run — that
    // run belongs to a different user message which was never aborted — and the
    // dropped completion is logged rather than silently swallowed.
    const warnings = captureConsole('warn');
    try {
      releaseAbort(true);
      await settle();
    } finally {
      warnings.restore();
    }

    assert.equal(chatRunRegistry.isProcessing('abort-race'), true, 'the newer run survives the stale abort');
    assert.equal(socket.framesOfKind('complete').length, 1, 'no second complete is emitted for the newer run');
    assert.equal(warnings.calls.length, 1, 'the dropped stale completion is surfaced to operators');
    assert.match(String(warnings.calls[0]?.[0]), /stale abort completion/);

    finishRun(calls[1] as SpawnCall);
    await settle();
    const completes = socket.framesOfKind('complete');
    assert.equal(completes.length, 2);
    assert.equal(completes[1]?.exitCode, 0, 'the newer run completes normally, not as an abort');
    assert.equal(completes[1]?.aborted, undefined);
  });
});

// ---------------------------------------------------------------------------
// chat.subscribe
// ---------------------------------------------------------------------------

test('chat.subscribe on an idle session acks isProcessing=false with no replay', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const { dependencies, approvalLookups } = makeDependencies(spawn);
    sessionsDb.createAppSession('quiet-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    emit(socket, { type: 'chat.subscribe', sessions: [{ sessionId: 'quiet-session' }] });
    await settle();

    assert.equal(socket.frames.length, 1, 'just the ack — nothing to replay');
    const ack = socket.frames[0] as Record<string, unknown>;
    assert.equal(ack.kind, 'chat_subscribed');
    assert.equal(ack.sessionId, 'quiet-session');
    assert.equal(ack.isProcessing, false);
    assert.equal(ack.interrupted, false);
    assert.equal(ack.lastSeq, 0);
    assert.deepEqual(ack.pendingPermissions, []);
    assert.equal(approvalLookups.length, 0, 'no provider id, so no approval lookup');
  });
});

test('chat.subscribe on a running session acks isProcessing=true and replays only events after lastSeq', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('live-session', 'claude', '/workspace/demo');

    const starter = new FakeSocket();
    connect(starter, dependencies);
    sendChat(starter, 'live-session', 'hello');
    await settle();

    const call = calls[0] as SpawnCall;
    call.writer.send({ kind: 'assistant', provider: 'claude', content: 'one' });
    call.writer.send({ kind: 'assistant', provider: 'claude', content: 'two' });
    call.writer.send({ kind: 'assistant', provider: 'claude', content: 'three' });

    // A refreshed tab reconnects having already seen seq 1.
    const reconnected = new FakeSocket();
    connect(reconnected, dependencies);
    emit(reconnected, { type: 'chat.subscribe', sessions: [{ sessionId: 'live-session', lastSeq: 1 }] });
    await settle();

    const ack = reconnected.frames[0] as Record<string, unknown>;
    assert.equal(ack.kind, 'chat_subscribed');
    assert.equal(ack.isProcessing, true);
    assert.equal(ack.lastSeq, 3, 'the ack reports the run head so the client can detect gaps');

    const replayed = reconnected.frames.slice(1);
    assert.deepEqual(replayed.map((frame) => frame.seq), [2, 3], 'strictly after lastSeq, in order');
    assert.deepEqual(replayed.map((frame) => frame.content), ['two', 'three']);
    assert.equal(replayed.every((frame) => frame.sessionId === 'live-session'), true);

    finishRun(call);
    await settle();
  });
});

test('chat.subscribe does not replay a completed run (REST history is authoritative)', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('done-session', 'claude', '/workspace/demo');

    const starter = new FakeSocket();
    connect(starter, dependencies);
    sendChat(starter, 'done-session', 'hello');
    await settle();
    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'answer' });
    finishRun(calls[0] as SpawnCall);
    await settle();

    const reloaded = new FakeSocket();
    connect(reloaded, dependencies);
    emit(reloaded, { type: 'chat.subscribe', sessions: [{ sessionId: 'done-session', lastSeq: 0 }] });
    await settle();

    assert.equal(reloaded.frames.length, 1, 'ack only — replaying would duplicate the history fetch');
    assert.equal(reloaded.frames[0]?.isProcessing, false);
    assert.equal(reloaded.frames[0]?.lastSeq, 2, 'the completed run head is still reported');
  });
});

test('chat.subscribe remaps pending permissions from the provider id to the app session id', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies, approvalLookups } = makeDependencies(spawn, {
      getPendingApprovalsForSession: (providerSessionId) => [
        { requestId: 'req-1', sessionId: providerSessionId, toolName: 'Bash' },
        'not-an-object',
        null,
      ],
    });
    sessionsDb.createAppSession('perm-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);
    sendChat(socket, 'perm-session', 'run a tool');
    await settle();
    (calls[0] as SpawnCall).writer.setSessionId('native-perm');

    emit(socket, { type: 'chat.subscribe', sessions: [{ sessionId: 'perm-session' }] });
    await settle();

    assert.deepEqual(approvalLookups, ['native-perm'], 'approvals are looked up by provider-native id');
    const ack = socket.frames.find((frame) => frame.kind === 'chat_subscribed') as Record<string, unknown>;
    assert.deepEqual(ack.pendingPermissions, [
      { requestId: 'req-1', sessionId: 'perm-session', toolName: 'Bash' },
      'not-an-object',
      null,
    ]);

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

test('chat.subscribe re-attaches the live stream to the subscribing socket', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('attach-session', 'claude', '/workspace/demo');

    const original = new FakeSocket();
    connect(original, dependencies);
    sendChat(original, 'attach-session', 'hello');
    await settle();

    const refreshed = new FakeSocket();
    connect(refreshed, dependencies);
    emit(refreshed, { type: 'chat.subscribe', sessions: [{ sessionId: 'attach-session', lastSeq: 0 }] });
    await settle();

    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'after refresh' });

    assert.equal(
      refreshed.frames.some((frame) => frame.content === 'after refresh'),
      true,
      'the refreshed tab receives the still-running stream',
    );

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

test('chat.subscribe skips malformed targets without failing the whole batch', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('good-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    emit(socket, {
      type: 'chat.subscribe',
      sessions: [null, 'string-target', {}, { sessionId: '  ' }, { sessionId: 'good-session' }],
    });
    await settle();

    assert.equal(socket.frames.length, 1, 'only the one valid target is acked');
    assert.equal(socket.frames[0]?.sessionId, 'good-session');
    assert.equal(socket.protocolErrors().length, 0, 'garbage entries are skipped, not fatal');

    // A subscribe with no (or a non-array) `sessions` field is a silent no-op.
    emit(socket, { type: 'chat.subscribe' });
    emit(socket, { type: 'chat.subscribe', sessions: 'nope' });
    await settle();
    assert.equal(socket.frames.length, 1);
  });
});

test('chat.subscribe coerces a hostile lastSeq instead of trusting it', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('seq-session', 'claude', '/workspace/demo');

    const starter = new FakeSocket();
    connect(starter, dependencies);
    sendChat(starter, 'seq-session', 'hello');
    await settle();
    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'one' });
    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'two' });

    // Negative, fractional, non-numeric and non-finite values all fall back to a
    // safe floor rather than skipping or exploding the replay.
    for (const [index, lastSeq] of [-5, 1.9, 'one', Number.NaN, Number.POSITIVE_INFINITY].entries()) {
      const socket = new FakeSocket();
      connect(socket, dependencies);
      emit(socket, { type: 'chat.subscribe', sessions: [{ sessionId: 'seq-session', lastSeq }] });
      await settle(1);

      const replayed = socket.frames.slice(1).map((frame) => frame.seq);
      if (index === 1) {
        assert.deepEqual(replayed, [2], 'a fractional lastSeq floors to 1');
      } else {
        // Negative, non-numeric and non-finite values all fall back to 0, so the
        // client is over-served (a full replay) rather than silently skipped past.
        assert.deepEqual(replayed, [1, 2], `lastSeq ${String(lastSeq)} is treated as 0`);
      }
    }

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

// ---------------------------------------------------------------------------
// chat.permission-response
// ---------------------------------------------------------------------------

test('chat.permission-response forwards the normalized decision to the approval resolver', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const resolved: Array<{ requestId: string; payload: Record<string, unknown> }> = [];
    const { dependencies } = makeDependencies(spawn, {
      resolveToolApproval: (requestId, payload) => {
        resolved.push({ requestId, payload });
      },
    });

    const socket = new FakeSocket();
    connect(socket, dependencies);

    emit(socket, {
      type: 'chat.permission-response',
      requestId: 'req-1',
      allow: true,
      updatedInput: { command: 'ls -la' },
      message: 'approved',
      rememberEntry: { tool: 'Bash', scope: 'session' },
    });
    // A denial with a non-string message: `message` is normalized away, `allow`
    // is coerced from whatever the client sent.
    emit(socket, { type: 'chat.permission-response', requestId: 'req-2', allow: 0, message: 42 });
    await settle();

    assert.deepEqual(resolved.map((entry) => entry.requestId), ['req-1', 'req-2']);
    assert.deepEqual(resolved[0]?.payload, {
      allow: true,
      updatedInput: { command: 'ls -la' },
      message: 'approved',
      rememberEntry: { tool: 'Bash', scope: 'session' },
    });
    assert.equal(resolved[1]?.payload.allow, false);
    assert.equal(resolved[1]?.payload.message, undefined);
    assert.equal(socket.protocolErrors().length, 0);
  });
});

test('chat.permission-response without a usable requestId is ignored', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const resolved: string[] = [];
    const { dependencies } = makeDependencies(spawn, {
      resolveToolApproval: (requestId) => {
        resolved.push(requestId);
      },
    });

    const socket = new FakeSocket();
    connect(socket, dependencies);

    emit(socket, { type: 'chat.permission-response', allow: true });
    emit(socket, { type: 'chat.permission-response', requestId: '', allow: true });
    emit(socket, { type: 'chat.permission-response', requestId: 7, allow: true });
    await settle();

    assert.deepEqual(resolved, [], 'nothing is resolved for an unaddressable response');
    assert.equal(socket.frames.length, 0, 'and the client is not spammed with errors');
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle and protocol errors
// ---------------------------------------------------------------------------

test('unknown and missing message types are reported as UNKNOWN_MESSAGE_TYPE', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    const socket = new FakeSocket();
    connect(socket, dependencies);

    emit(socket, { type: 'chat.teleport', sessionId: 'x' });
    emit(socket, { sessionId: 'x' });
    emit(socket, { type: 42 });
    await settle();

    const errors = socket.protocolErrors();
    assert.equal(errors.length, 3);
    assert.equal(errors.every((frame) => frame.code === 'UNKNOWN_MESSAGE_TYPE'), true);
    assert.match(String(errors[0]?.error), /chat\.teleport/);
    assert.equal(errors[1]?.sessionId, null, 'protocol errors always carry an explicit sessionId field');
  });
});

test('an unparseable frame is reported as INTERNAL_ERROR and never tears down the socket', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('after-garbage', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);

    emit(socket, 'not json at all');
    emit(socket, '"a bare string"');
    emit(socket, '[1,2,3]');
    await settle();

    const errors = socket.protocolErrors();
    assert.equal(errors.length, 3);
    assert.equal(errors.every((frame) => frame.code === 'INTERNAL_ERROR'), true);

    // The connection is still fully usable afterwards.
    sendChat(socket, 'after-garbage', 'still works');
    await settle();
    assert.equal(calls.length, 1);
    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

test('connect registers the socket for broadcasts and close unregisters it', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);

    const socket = new FakeSocket();
    connect(socket, dependencies);
    assert.equal(connectedClients.has(socket as never), true);

    socket.emit('close');
    assert.equal(connectedClients.has(socket as never), false);
  });
});

test('frames for a socket that closed mid-run are dropped, not thrown, and the run keeps going', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('closed-session', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);
    sendChat(socket, 'closed-session', 'hello');
    await settle();

    socket.readyState = 3; // CLOSED
    socket.emit('close');
    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'into the void' });

    assert.equal(socket.frames.length, 0, 'nothing is written to a closed socket');
    assert.equal(chatRunRegistry.isProcessing('closed-session'), true, 'the run is not cancelled');
    assert.equal(
      chatRunRegistry.replayEvents('closed-session', 0).length,
      1,
      'the event is still buffered for a later subscribe',
    );

    finishRun(calls[0] as SpawnCall);
    await settle();
  });
});

// ---------------------------------------------------------------------------
// Multi-device fan-out (issue #204)
// ---------------------------------------------------------------------------

test('a second device subscribing joins the live stream without stealing it from the first', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('two-device', 'claude', '/workspace/demo');

    const phone = new FakeSocket();
    const laptop = new FakeSocket();
    connect(phone, dependencies);
    connect(laptop, dependencies);

    sendChat(phone, 'two-device', 'hello');
    await settle();
    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'chunk-1' });
    assert.equal(phone.framesOfKind('assistant').length, 1, 'the sending device streams normally');

    // The laptop opens the same session while the run is live. The run now holds
    // a SET of subscribers, so the laptop JOINS the fan-out (replaying what it
    // missed) instead of stealing the stream from the phone.
    emit(laptop, { type: 'chat.subscribe', sessions: [{ sessionId: 'two-device', lastSeq: 0 }] });
    await settle();
    assert.deepEqual(
      laptop.frames.filter((frame) => frame.kind === 'assistant').map((frame) => frame.content),
      ['chunk-1'],
      'the late subscriber replays the event it missed',
    );

    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'chunk-2' });

    // BOTH devices receive the live event — the phone was not cut off.
    assert.deepEqual(
      phone.frames.filter((frame) => frame.kind === 'assistant').map((frame) => frame.content),
      ['chunk-1', 'chunk-2'],
      'the original device keeps streaming after a second device joins',
    );
    assert.equal(
      laptop.frames.filter((frame) => frame.content === 'chunk-2').length,
      1,
      'the second device also receives the live event',
    );

    // If the laptop then goes away, it is pruned from the fan-out set, the run is
    // NOT cancelled, and the phone keeps receiving live events.
    laptop.readyState = 3;
    laptop.emit('close');
    assert.equal(
      chatRunRegistry.getRun('two-device')?.writer.connectionCount,
      1,
      'the closed subscriber is pruned, leaving just the phone',
    );

    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'chunk-3' });
    assert.deepEqual(
      phone.frames.filter((frame) => frame.kind === 'assistant').map((frame) => frame.content),
      ['chunk-1', 'chunk-2', 'chunk-3'],
      'the surviving device keeps receiving after the other closes',
    );
    assert.equal(laptop.framesOfKind('assistant').length, 2, 'nothing is written to the closed socket');
    assert.equal(chatRunRegistry.isProcessing('two-device'), true, 'the run itself is untouched');

    // Both live subscribers get the terminal complete without needing to
    // re-subscribe — the phone's panel leaves "processing" on its own.
    finishRun(calls[0] as SpawnCall);
    await settle();
    assert.equal(phone.framesOfKind('complete').length, 1, 'the original device gets the terminal complete');
  });
});

test('a background run keeps running when its viewer drops and re-attaches on reconnect', async () => {
  await withIsolatedDatabase(async () => {
    const { spawn, calls } = makeControllableSpawn();
    const { dependencies } = makeDependencies(spawn);
    sessionsDb.createAppSession('background-run', 'claude', '/workspace/demo');

    const socket = new FakeSocket();
    connect(socket, dependencies);
    sendChat(socket, 'background-run', 'hello');
    await settle();

    // The only viewer disconnects (tab closed / network drop). The run is not
    // cancelled and keeps producing events, which buffer for a later subscriber.
    socket.readyState = 3;
    socket.emit('close');
    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'while away' });
    assert.equal(chatRunRegistry.isProcessing('background-run'), true, 'the run keeps going with no live subscriber');
    assert.equal(socket.frames.length, 0, 'the dead socket received nothing while disconnected');

    // A reconnecting client re-subscribes the session (the frontend now
    // re-subscribes every running session, not just the viewed one). It
    // RE-ATTACHES: replays what it missed and receives subsequent live events.
    const reconnected = new FakeSocket();
    connect(reconnected, dependencies);
    emit(reconnected, { type: 'chat.subscribe', sessions: [{ sessionId: 'background-run', lastSeq: 0 }] });
    await settle();
    assert.deepEqual(
      reconnected.frames.filter((frame) => frame.kind === 'assistant').map((frame) => frame.content),
      ['while away'],
      'the reconnecting client replays the events buffered while it was gone',
    );

    (calls[0] as SpawnCall).writer.send({ kind: 'assistant', provider: 'claude', content: 'after reconnect' });
    assert.equal(
      reconnected.frames.some((frame) => frame.content === 'after reconnect'),
      true,
      'and receives new live events on the reconnected socket',
    );

    finishRun(calls[0] as SpawnCall);
    await settle();

    // The run still completes and persists its durable Done state, AND the
    // reconnected client gets the terminal complete live.
    assert.equal(chatRunRegistry.isProcessing('background-run'), false);
    assert.equal(reconnected.framesOfKind('complete').length, 1, 'the reconnected client gets the terminal complete');
    assert.equal(socket.frames.length, 0, 'the dead socket still received nothing');
    assert.ok(
      sessionsDb.getSessionById('background-run')?.last_completed_at,
      'completion is still persisted as the durable Done state',
    );
    assert.equal(
      chatRunRegistry.replayEvents('background-run', 0).some((event) => event.kind === 'complete'),
      true,
      'and the terminal event is replayable for whoever subscribes next',
    );
  });
});
