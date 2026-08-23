import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { attachHeartbeat } from '@/modules/websocket/services/websocket-server.service.js';

/**
 * The terminate-on-silence half of the websocket heartbeat (#389).
 *
 * WHY THIS MATTERS. Before this, the server pinged every 30s and never listened
 * for the answer. A client whose connection had black-holed — a slept laptop, a
 * network handover — never sends a FIN, so the socket stayed in `connectedClients`
 * forever, still holding the writer for any run fanning out to it. The ping was a
 * proxy keepalive, not a liveness check. These tests pin the difference.
 */

/** Minimal `ws`-shaped socket driven entirely by the test. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  pings = 0;
  terminated = 0;

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated += 1;
    this.emit('close');
  }
}

/** A hand-driven interval so the test decides when each beat happens. */
function makeScheduler() {
  const handlers = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler = {
    setInterval: (handler: () => void) => {
      const handle = nextHandle;
      nextHandle += 1;
      handlers.set(handle, handler);
      return handle;
    },
    clearInterval: (handle: never) => {
      handlers.delete(handle as unknown as number);
    },
  };
  /** Fires every live interval once. */
  const beat = () => {
    for (const handler of [...handlers.values()]) handler();
  };
  return { scheduler, beat, liveTimers: () => handlers.size };
}

test('a socket that answers every ping is never terminated', () => {
  const ws = new FakeSocket();
  const { scheduler, beat } = makeScheduler();
  attachHeartbeat(ws, 30_000, scheduler as never);

  for (let i = 0; i < 5; i += 1) {
    beat();
    ws.emit('pong'); // a healthy peer replies before the next beat
  }

  assert.equal(ws.pings, 5);
  assert.equal(ws.terminated, 0, 'a responsive socket must survive indefinitely');
});

test('a socket that misses one pong is terminated on the next beat', () => {
  const ws = new FakeSocket();
  const { scheduler, beat } = makeScheduler();
  attachHeartbeat(ws, 30_000, scheduler as never);

  beat(); // ping goes out
  assert.equal(ws.pings, 1);
  assert.equal(ws.terminated, 0, 'one unanswered ping is not yet proof of death');

  beat(); // no pong arrived in between — this is the black-holed case
  assert.equal(ws.terminated, 1, 'the dead peer must be reaped, not pinged forever');
});

test('terminating stops the heartbeat, so a dead socket is reaped once', () => {
  const ws = new FakeSocket();
  const { scheduler, beat, liveTimers } = makeScheduler();
  attachHeartbeat(ws, 30_000, scheduler as never);

  beat();
  beat(); // terminates, which emits 'close', which clears the interval

  assert.equal(liveTimers(), 0, 'the interval must not outlive the socket');
  beat(); // no-op: nothing is scheduled anymore
  assert.equal(ws.terminated, 1);
});

test('a pong resets the deadline, so an intermittently quiet socket survives', () => {
  const ws = new FakeSocket();
  const { scheduler, beat } = makeScheduler();
  attachHeartbeat(ws, 30_000, scheduler as never);

  beat();            // ping 1 sent, awaiting
  ws.emit('pong');   // answered
  beat();            // ping 2 sent, awaiting
  ws.emit('pong');   // answered
  beat();            // ping 3 sent, awaiting

  assert.equal(ws.terminated, 0);
  assert.equal(ws.pings, 3);
});

test('closing the socket stops the heartbeat', () => {
  const ws = new FakeSocket();
  const { scheduler, beat, liveTimers } = makeScheduler();
  attachHeartbeat(ws, 30_000, scheduler as never);

  ws.emit('close');
  assert.equal(liveTimers(), 0);

  beat();
  assert.equal(ws.pings, 0, 'a closed socket must not still be pinged');
});

test('a socket that is not OPEN is not pinged', () => {
  const ws = new FakeSocket();
  ws.readyState = 0; // CONNECTING
  const { scheduler, beat } = makeScheduler();
  attachHeartbeat(ws, 30_000, scheduler as never);

  beat();
  assert.equal(ws.pings, 0);
  // Nothing was asked, so nothing can be overdue: it must not be terminated.
  beat();
  assert.equal(ws.terminated, 0);
});
