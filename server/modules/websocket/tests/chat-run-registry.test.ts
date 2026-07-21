import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
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

test('live events are remapped to the app session id and sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-2', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'codex',
      sessionId: 'codex-native-7',
      newSessionId: 'codex-native-7',
    });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal(sessionUpserts[0]?.providerSessionId, 'codex-native-7');
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'codex-native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'codex-native-7');
  });
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1 });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns returns only currently running app sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0 });

    const runningSessions = chatRunRegistry.listRunningRuns();
    assert.deepEqual(runningSessions.map((session) => session.sessionId), ['app-run-8']);
    assert.equal(runningSessions[0]?.provider, 'codex');
  });
});

test('listRunningRuns reports blocked and refcounts concurrent approvals', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-blocked', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-blocked',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    const blocked = () => chatRunRegistry.listRunningRuns()[0]?.blocked;

    // Defaults to not blocked.
    assert.equal(blocked(), false);

    // A single approval flips it on, then off.
    run.writer.setBlocked(true);
    assert.equal(blocked(), true);
    run.writer.setBlocked(false);
    assert.equal(blocked(), false);

    // Two concurrent approvals: the first to resolve must NOT clear the flag
    // while the second is still pending (refcounted, not last-writer-wins).
    run.writer.setBlocked(true);
    run.writer.setBlocked(true);
    assert.equal(blocked(), true);
    run.writer.setBlocked(false);
    assert.equal(blocked(), true);
    run.writer.setBlocked(false);
    assert.equal(blocked(), false);
  });
});

test('a completed run stamps last_completed_at for the durable Done state', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-done', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-done',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    assert.equal(sessionsDb.getSessionById('app-run-done')?.last_completed_at, null);

    // The terminal complete flows through decorateAndRecordEvent, the single
    // completion choke point, which persists the finish time.
    run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-done', exitCode: 0 });

    assert.ok(
      sessionsDb.getSessionById('app-run-done')?.last_completed_at,
      'completion should stamp last_completed_at',
    );
  });
});

test('writer.isRunActive reflects the run status (drives provider retry bail-out)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-active', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-active',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    assert.equal(run.writer.isRunActive(), true);

    // chat.abort completes the run in the registry; isRunActive must flip so a
    // provider mid-retry stops instead of streaming into a finished session.
    chatRunRegistry.completeRun('app-run-active', { exitCode: 1 });
    assert.equal(run.writer.isRunActive(), false);
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
  });
});

test('attachConnection reroutes the live stream to a new socket', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'codex', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'codex',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'codex', sessionId: 'o', content: 'before' });

    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'codex', sessionId: 'o', content: 'after' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0 });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});

/* ------------------------------------------------------------------ */
/*  Server-side per-session FIFO queue (issue #64)                     */
/* ------------------------------------------------------------------ */

function makeQueuedMessage(connection: FakeConnection, content: string) {
  return {
    content,
    options: {} as Record<string, unknown>,
    connection: connection as never,
    userId: null,
    enqueuedAt: Date.now(),
  };
}

test('submitMessage starts the first send and queues concurrent sends in FIFO order', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('q-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const input = {
      appSessionId: 'q-1',
      provider: 'claude' as const,
      providerSessionId: null,
      connection: connection as never,
      userId: null,
    };

    const first = chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'A'));
    assert.equal(first.action, 'start');
    assert.equal(chatRunRegistry.isProcessing('q-1'), true);
    assert.equal(chatRunRegistry.isDispatching('q-1'), true);

    // A run is already in progress: further sends join the queue instead of
    // being rejected (the old behaviour that silently dropped the loser).
    const second = chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'B'));
    const third = chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'C'));
    assert.equal(second.action, 'queued');
    assert.equal(third.action, 'queued');

    assert.equal(chatRunRegistry.getPendingCount('q-1'), 2);
    assert.deepEqual(chatRunRegistry.listPending('q-1').map((m) => m.content), ['B', 'C']);
  });
});

test('takeNextQueued drains the queue in FIFO order and releases the dispatcher when empty', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('q-2', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const input = {
      appSessionId: 'q-2',
      provider: 'claude' as const,
      providerSessionId: null,
      connection: connection as never,
      userId: null,
    };

    chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'A')); // start
    chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'B')); // queued
    chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'C')); // queued

    // The head run finishes; the dispatcher pulls the next queued message.
    chatRunRegistry.completeRun('q-2', { exitCode: 0 });

    assert.equal(chatRunRegistry.takeNextQueued('q-2')?.content, 'B');
    assert.equal(chatRunRegistry.isDispatching('q-2'), true); // still draining
    assert.equal(chatRunRegistry.takeNextQueued('q-2')?.content, 'C');
    assert.equal(chatRunRegistry.takeNextQueued('q-2'), null); // empty
    assert.equal(chatRunRegistry.isDispatching('q-2'), false); // released
    assert.equal(chatRunRegistry.getPendingCount('q-2'), 0);
  });
});

test('submitMessage queues (not starts) in the gap after a run completes while a dispatcher is active', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('q-3', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const input = {
      appSessionId: 'q-3',
      provider: 'claude' as const,
      providerSessionId: null,
      connection: connection as never,
      userId: null,
    };

    chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'A')); // start + dispatching
    chatRunRegistry.completeRun('q-3', { exitCode: 0 }); // run done, dispatcher still held

    // This is the exact race window: the run has completed but the dispatcher
    // has not yet pulled the next message. A send here must queue, or a second
    // dispatcher would start and one message could be lost.
    assert.equal(chatRunRegistry.isProcessing('q-3'), false);
    assert.equal(chatRunRegistry.isDispatching('q-3'), true);

    const res = chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'B'));
    assert.equal(res.action, 'queued');
    assert.equal(chatRunRegistry.getPendingCount('q-3'), 1);
  });
});

test('submitMessage rejects past the pending-queue cap instead of dropping silently', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('q-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const input = {
      appSessionId: 'q-4',
      provider: 'claude' as const,
      providerSessionId: null,
      connection: connection as never,
      userId: null,
    };

    chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'head')); // start
    for (let i = 0; i < 50; i += 1) {
      const queued = chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, `m${i}`));
      assert.equal(queued.action, 'queued');
    }

    // The 51st queued message overflows the cap: rejected VISIBLY (the caller
    // surfaces a protocol error), never silently discarded.
    const overflow = chatRunRegistry.submitMessage(input, makeQueuedMessage(connection, 'overflow'));
    assert.equal(overflow.action, 'rejected');
    assert.equal(chatRunRegistry.getPendingCount('q-4'), 50);
  });
});

/** How long a completed run stays replayable (COMPLETED_RUN_RETENTION_MS). */
const RETENTION_MS = 5 * 60 * 1000;

test('a completed run stays replayable for the retention window, then is evicted', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('retained', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    // Timers are faked only around the eviction itself — the database is already
    // initialized, and they are reset before teardown.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const run = chatRunRegistry.startRun({
        appSessionId: 'retained',
        provider: 'claude',
        providerSessionId: null,
        connection,
        userId: null,
      });
      assert.ok(run);

      run.writer.send({ kind: 'assistant', provider: 'claude', content: 'answer' });
      chatRunRegistry.completeRun('retained', { exitCode: 0 });
      assert.equal(chatRunRegistry.isProcessing('retained'), false);

      // A client that was asleep while the run finished can still replay it right
      // up to the end of the retention window.
      mock.timers.tick(RETENTION_MS - 1);
      assert.equal(chatRunRegistry.getRun('retained')?.status, 'completed');
      assert.equal(chatRunRegistry.replayEvents('retained', 0).length, 2, 'event + terminal complete');

      // Past the window the buffer is released; replay falls back to REST history.
      mock.timers.tick(2);
      assert.equal(chatRunRegistry.getRun('retained'), undefined);
      assert.deepEqual(chatRunRegistry.replayEvents('retained', 0), []);
      assert.equal(chatRunRegistry.isProcessing('retained'), false, 'an evicted run reads as idle, not running');
    } finally {
      mock.timers.reset();
    }
  });
});

test('the eviction timer never removes the session\'s newer, still-running run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('reused', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const input = {
      appSessionId: 'reused',
      provider: 'claude' as const,
      providerSessionId: null,
      connection: connection as never,
      userId: null,
    };

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      assert.ok(chatRunRegistry.startRun(input));
      chatRunRegistry.completeRun('reused', { exitCode: 0 });

      // A follow-up turn replaces the map entry well before the first run's
      // eviction timer fires. That timer must not delete the live run.
      mock.timers.tick(RETENTION_MS / 2);
      const second = chatRunRegistry.startRun(input);
      assert.ok(second);

      mock.timers.tick(RETENTION_MS);
      assert.equal(chatRunRegistry.getRun('reused'), second, 'the running run survives the stale timer');
      assert.equal(chatRunRegistry.isProcessing('reused'), true);

      // Once it completes it gets its own timer and is evicted on its own clock.
      chatRunRegistry.completeRun('reused', { exitCode: 0 });
      mock.timers.tick(RETENTION_MS + 1);
      assert.equal(chatRunRegistry.getRun('reused'), undefined);
    } finally {
      mock.timers.reset();
    }
  });
});
