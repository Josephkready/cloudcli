import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { activeRunsDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { reconcileInterruptedRuns } from '@/modules/websocket/services/chat-run-reconcile.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/** Collects every JSON frame the gateway writer forwards. */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-persist-'));
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

function inputFor(connection: FakeConnection, sessionId: string) {
  return {
    appSessionId: sessionId,
    provider: 'claude' as const,
    providerSessionId: null,
    connection: connection as never,
    userId: 'user-1' as string | number | null,
  };
}

function makeQueuedMessage(connection: FakeConnection, content: string) {
  return {
    content,
    options: {} as Record<string, unknown>,
    connection: connection as never,
    userId: 'user-1' as string | number | null,
    enqueuedAt: Date.now(),
  };
}

function statuses(sessionId: string): string[] {
  return activeRunsDb.getBySession(sessionId).map((row) => row.status);
}

test('submitMessage persists a running journal row that a normal complete clears (no ghost)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('p1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    const result = chatRunRegistry.submitMessage(inputFor(connection, 'p1'), makeQueuedMessage(connection, 'hello'));
    assert.equal(result.action, 'start');
    assert.deepEqual(statuses('p1'), ['running'], 'a running row is journaled while the run is live');

    // A normal terminal complete funnels through the single completion choke
    // point, which deletes the journal row — so a later restart finds no ghost.
    chatRunRegistry.completeRun('p1', { exitCode: 0 });
    assert.deepEqual(statuses('p1'), [], 'the journal row is cleared on completion');
    assert.equal(reconcileInterruptedRuns().interruptedMessages, 0, 'a clean run surfaces nothing to reconcile');
  });
});

test('queued messages are journaled and the provider id is recorded on the running row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('p2', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    const first = chatRunRegistry.submitMessage(inputFor(connection, 'p2'), makeQueuedMessage(connection, 'A'));
    assert.equal(first.action, 'start');
    chatRunRegistry.submitMessage(inputFor(connection, 'p2'), makeQueuedMessage(connection, 'B'));
    chatRunRegistry.submitMessage(inputFor(connection, 'p2'), makeQueuedMessage(connection, 'C'));

    assert.deepEqual(statuses('p2'), ['running', 'queued', 'queued']);

    // The provider announces its native id mid-run; it must be journaled so a
    // resume can continue the same provider transcript.
    (first as { run: { writer: { setSessionId(id: string): void } } }).run.writer.setSessionId('provider-xyz');
    const runningRow = activeRunsDb.getBySession('p2').find((row) => row.status === 'running');
    assert.equal(runningRow?.provider_session_id, 'provider-xyz');
  });
});

test('reconcile after a simulated restart flags leftover running + queued rows as interrupted (nothing lost)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('p3', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    chatRunRegistry.submitMessage(inputFor(connection, 'p3'), makeQueuedMessage(connection, 'A')); // running
    chatRunRegistry.submitMessage(inputFor(connection, 'p3'), makeQueuedMessage(connection, 'B')); // queued
    chatRunRegistry.submitMessage(inputFor(connection, 'p3'), makeQueuedMessage(connection, 'C')); // queued
    assert.equal(activeRunsDb.getBySession('p3').length, 3);

    // A restart wipes the in-memory registry but the SQLite journal survives.
    chatRunRegistry.clearAll();

    const summary = reconcileInterruptedRuns();
    assert.equal(summary.interruptedSessions, 1);
    assert.equal(summary.interruptedMessages, 3);

    // Every message survives, in arrival order, as resumable work.
    assert.deepEqual(activeRunsDb.getInterrupted('p3').map((row) => row.content), ['A', 'B', 'C']);
    assert.equal(activeRunsDb.hasInterrupted('p3'), true);
  });
});

test('beginDrain refuses new runs; waitForActiveRuns is bounded and completes once runs finish', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('p4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    // With nothing running, the drain wait returns immediately as drained.
    const idle = await chatRunRegistry.waitForActiveRuns(50);
    assert.deepEqual(idle, { drained: true, remaining: 0, interrupted: 0 });

    const started = chatRunRegistry.submitMessage(inputFor(connection, 'p4'), makeQueuedMessage(connection, 'x'));
    assert.equal(started.action, 'start');

    // After the drain begins, a new send is refused (visible 'draining'), not
    // started — no run the imminent exit would guillotine.
    chatRunRegistry.beginDrain();
    assert.equal(chatRunRegistry.isDraining(), true);
    const refused = chatRunRegistry.submitMessage(inputFor(connection, 'p4'), makeQueuedMessage(connection, 'y'));
    assert.equal(refused.action, 'draining');
    assert.equal(chatRunRegistry.countRunningRuns(), 1, 'the in-flight run keeps running through the drain');

    // The bounded wait times out while the run is still live, reporting it.
    const timedOut = await chatRunRegistry.waitForActiveRuns(120, 20);
    assert.equal(timedOut.drained, false);
    assert.equal(timedOut.remaining, 1);

    // Letting the in-flight run finish drains the server cleanly.
    chatRunRegistry.completeRun('p4', { exitCode: 0 });
    const drained = await chatRunRegistry.waitForActiveRuns(120, 20);
    assert.deepEqual(drained, { drained: true, remaining: 0, interrupted: 0 });
  });
});

test('a run killed mid-drain keeps its journal row and resumes after restart (#535)', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('p5', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('p6', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('p7', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    for (const id of ['p5', 'p6', 'p7']) {
      const started = chatRunRegistry.submitMessage(inputFor(connection, id), makeQueuedMessage(connection, id));
      assert.equal(started.action, 'start');
    }

    chatRunRegistry.beginDrain();

    // p5: the provider child dies with the server's signal (exit 143) — the
    // runtime reports it as a failed complete.
    chatRunRegistry.completeRun('p5', { exitCode: 1 });
    // p6: finishes normally within the drain window.
    chatRunRegistry.completeRun('p6', { exitCode: 0 });
    // p7: the user stopped it during the drain — a deliberate end, not a loss.
    chatRunRegistry.completeRun('p7', { exitCode: 1, aborted: true });

    assert.deepEqual(statuses('p5'), ['running'], 'the killed run stays journaled');
    assert.deepEqual(statuses('p6'), [], 'a clean finish still clears its row');
    assert.deepEqual(statuses('p7'), [], 'an abort still clears its row');

    const result = await chatRunRegistry.waitForActiveRuns(50, 10);
    assert.deepEqual(result, { drained: true, remaining: 0, interrupted: 1 });

    // After the restart, only the killed run surfaces as resumable.
    chatRunRegistry.clearAll();
    const summary = reconcileInterruptedRuns();
    assert.equal(summary.interruptedSessions, 1);
    assert.equal(activeRunsDb.hasInterrupted('p5'), true);
  });
});

test('outside a drain, a failed run still clears its journal row (no ghost resume)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('p8', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    chatRunRegistry.submitMessage(inputFor(connection, 'p8'), makeQueuedMessage(connection, 'x'));
    chatRunRegistry.completeRun('p8', { exitCode: 1 });

    assert.deepEqual(statuses('p8'), []);
    assert.equal(reconcileInterruptedRuns().interruptedMessages, 0);
  });
});
