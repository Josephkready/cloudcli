import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  createSessionUpsertDebouncer,
  type SessionUpsertBatch,
} from '@/modules/providers/services/session-upsert-debouncer.js';

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 2_000;

type Recorder = {
  batches: Array<{ providers: string[]; changeTypes: string[]; sessionIds: string[] }>;
  record: (batch: SessionUpsertBatch) => void;
};

function createRecorder(): Recorder {
  const batches: Recorder['batches'] = [];
  return {
    batches,
    record(batch) {
      batches.push({
        providers: [...batch.providers],
        changeTypes: [...batch.changeTypes],
        sessionIds: [...batch.updatedSessionIds],
      });
    },
  };
}

/**
 * `Date` is faked alongside `setTimeout` so the max-wait arithmetic (which reads
 * Date.now()) advances in lockstep with the timers the tests tick.
 */
function enableFakeTimers(): void {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
}

test('coalesces a burst of events into a single flush after the debounce window', () => {
  enableFakeTimers();
  const recorder = createRecorder();
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: recorder.record,
  });

  try {
    debouncer.queue('add', 'claude', 'session-a');
    debouncer.queue('change', 'claude', 'session-a');
    debouncer.queue('change', 'codex', 'session-b');

    mock.timers.tick(DEBOUNCE_MS - 1);
    assert.equal(recorder.batches.length, 0, 'must not flush before the quiet period elapses');

    mock.timers.tick(1);
    assert.equal(recorder.batches.length, 1);
    assert.deepEqual(recorder.batches[0].sessionIds, ['session-a', 'session-b']);
    assert.deepEqual(recorder.batches[0].providers, ['claude', 'codex']);
    assert.deepEqual(recorder.batches[0].changeTypes, ['add', 'change']);
  } finally {
    mock.timers.reset();
  }
});

test('a repeated session id is broadcast once per batch, not once per event', () => {
  enableFakeTimers();
  const recorder = createRecorder();
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: recorder.record,
  });

  try {
    for (let index = 0; index < 20; index += 1) {
      debouncer.queue('change', 'claude', 'session-a');
    }

    mock.timers.tick(DEBOUNCE_MS);
    assert.deepEqual(recorder.batches, [{
      providers: ['claude'],
      changeTypes: ['change'],
      sessionIds: ['session-a'],
    }]);
  } finally {
    mock.timers.reset();
  }
});

test('each new event slides the debounce window forward', () => {
  enableFakeTimers();
  const recorder = createRecorder();
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: recorder.record,
  });

  try {
    debouncer.queue('change', 'claude', 'session-a');
    mock.timers.tick(400);
    debouncer.queue('change', 'claude', 'session-b');
    mock.timers.tick(400);
    assert.equal(recorder.batches.length, 0, 'the second event must restart the quiet period');

    mock.timers.tick(100);
    assert.equal(recorder.batches.length, 1);
    assert.deepEqual(recorder.batches[0].sessionIds, ['session-a', 'session-b']);
  } finally {
    mock.timers.reset();
  }
});

test('the max-wait ceiling stops a steady event stream from starving the flush', () => {
  enableFakeTimers();
  const recorder = createRecorder();
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: recorder.record,
  });

  try {
    // An event every 400ms keeps resetting the 500ms debounce forever, so
    // without the ceiling the sidebar would never see the update.
    for (let elapsed = 0; elapsed < MAX_WAIT_MS; elapsed += 400) {
      debouncer.queue('change', 'claude', `session-${elapsed}`);
      mock.timers.tick(400);
    }

    assert.equal(recorder.batches.length, 1, 'the batch must land at the max-wait ceiling');
    assert.deepEqual(recorder.batches[0].sessionIds, [
      'session-0',
      'session-400',
      'session-800',
      'session-1200',
      'session-1600',
    ]);
  } finally {
    mock.timers.reset();
  }
});

test('events arriving during an in-flight flush are delivered in a follow-up batch', async () => {
  enableFakeTimers();
  const recorder = createRecorder();
  let releaseFlush: () => void = () => {};
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: async (batch) => {
      recorder.record(batch);
      if (recorder.batches.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFlush = resolve;
        });
      }
    },
  });

  try {
    debouncer.queue('change', 'claude', 'session-a');
    mock.timers.tick(DEBOUNCE_MS);
    await Promise.resolve();

    assert.equal(recorder.batches.length, 1);
    assert.deepEqual(recorder.batches[0].sessionIds, ['session-a']);

    // Arrives while the first broadcast is still awaiting.
    debouncer.queue('change', 'claude', 'session-b');
    mock.timers.tick(DEBOUNCE_MS);
    assert.equal(recorder.batches.length, 1, 'a re-entrant flush must not run concurrently');

    releaseFlush();
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(DEBOUNCE_MS);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(recorder.batches.length, 2, 'the queued batch must still be delivered');
    assert.deepEqual(recorder.batches[1].sessionIds, ['session-b']);
  } finally {
    releaseFlush();
    mock.timers.reset();
  }
});

test('a batch is never delivered twice when a flush overlaps its own reschedule', async () => {
  enableFakeTimers();
  const recorder = createRecorder();
  let releaseFlush: () => void = () => {};
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: async (batch) => {
      recorder.record(batch);
      await new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
    },
  });

  try {
    debouncer.queue('change', 'claude', 'session-a');
    mock.timers.tick(DEBOUNCE_MS);
    await Promise.resolve();
    assert.equal(recorder.batches.length, 1);

    // Nothing new was queued, so re-driving the timer must be a no-op rather
    // than re-broadcasting the in-flight batch.
    mock.timers.tick(MAX_WAIT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorder.batches.length, 1);

    releaseFlush();
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(MAX_WAIT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorder.batches.length, 1);
    assert.equal(debouncer.hasPendingBatch(), false);
  } finally {
    releaseFlush();
    mock.timers.reset();
  }
});

test('a throwing flush is reported and does not wedge later batches', async () => {
  enableFakeTimers();
  const recorder = createRecorder();
  const errors: unknown[] = [];
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: (batch) => {
      recorder.record(batch);
      if (recorder.batches.length === 1) {
        throw new Error('broadcast blew up');
      }
    },
    onError: (error) => errors.push(error),
  });

  try {
    debouncer.queue('change', 'claude', 'session-a');
    mock.timers.tick(DEBOUNCE_MS);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'broadcast blew up');

    debouncer.queue('change', 'claude', 'session-b');
    mock.timers.tick(DEBOUNCE_MS);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(recorder.batches.length, 2, 'the state machine must recover after a failed flush');
    assert.deepEqual(recorder.batches[1].sessionIds, ['session-b']);
  } finally {
    mock.timers.reset();
  }
});

test('events with no resolvable session id still form a batch', () => {
  enableFakeTimers();
  const recorder = createRecorder();
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: recorder.record,
  });

  try {
    debouncer.queue('add', 'claude', null);
    mock.timers.tick(DEBOUNCE_MS);

    assert.equal(recorder.batches.length, 1);
    assert.deepEqual(recorder.batches[0].sessionIds, []);
  } finally {
    mock.timers.reset();
  }
});

test('reset drops the queued batch and its pending timer', () => {
  enableFakeTimers();
  const recorder = createRecorder();
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: recorder.record,
  });

  try {
    debouncer.queue('change', 'claude', 'session-a');
    assert.equal(debouncer.hasPendingBatch(), true);

    debouncer.reset();
    assert.equal(debouncer.hasPendingBatch(), false);

    mock.timers.tick(MAX_WAIT_MS * 2);
    assert.equal(recorder.batches.length, 0, 'a shut-down watcher must not broadcast');
  } finally {
    mock.timers.reset();
  }
});

test('flush on an empty queue is a no-op', async () => {
  enableFakeTimers();
  const recorder = createRecorder();
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: recorder.record,
  });

  try {
    await debouncer.flush();
    assert.equal(recorder.batches.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('a fresh batch after a flush restarts the debounce window from scratch', async () => {
  enableFakeTimers();
  const recorder = createRecorder();
  const debouncer = createSessionUpsertDebouncer({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    onFlush: recorder.record,
  });

  try {
    debouncer.queue('change', 'claude', 'session-a');
    mock.timers.tick(DEBOUNCE_MS);
    // Let the first flush settle: it only clears its in-flight guard once its
    // awaited onFlush resolves.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorder.batches.length, 1);

    // Idle long enough that the *first* batch's max-wait budget is spent. The
    // max-wait clock is per-batch, so the second batch must still get its full
    // quiet period — inheriting the stale start time would collapse its delay
    // to 0 and broadcast a half-written transcript on the very first event.
    mock.timers.tick(MAX_WAIT_MS);
    debouncer.queue('change', 'claude', 'session-b');
    mock.timers.tick(DEBOUNCE_MS - 1);
    assert.equal(recorder.batches.length, 1);

    mock.timers.tick(1);
    assert.equal(recorder.batches.length, 2);
    assert.deepEqual(recorder.batches[1].sessionIds, ['session-b']);
  } finally {
    mock.timers.reset();
  }
});
