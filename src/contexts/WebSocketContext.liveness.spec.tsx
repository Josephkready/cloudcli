import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSocketProvider, useWebSocket } from './WebSocketContext';

/**
 * Liveness detection for the chat websocket (#389).
 *
 * WHY THIS SUITE EXISTS. The reported bug was "chats are stuck until you close
 * and reopen the app". The cause: a socket whose connection has black-holed —
 * the Mac slept, the network changed — stays `readyState === OPEN` forever. It
 * fires no `close` and no `error`, and the reconnect was keyed solely on
 * `onclose`, so the app sat wedged with `isConnected === true`, accepting sends
 * that evaporated, until the page was reloaded.
 *
 * WHAT THESE TESTS CAN AND CANNOT SHOW. A half-open socket is *defined* by
 * observable behaviour at the WebSocket API boundary — readyState stays OPEN,
 * no frames arrive, `send()` reports success — so a fake socket models it
 * faithfully; there is no engine-specific rendering involved the way there is in
 * a layout bug. What a fake cannot prove is that a real Safari leaves the socket
 * OPEN rather than closing it, which is the premise, not the logic. These lock
 * the state machine: probe when silent, tear down when unanswered, and never
 * tear down a socket that is talking.
 */

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Mirrors the provider's own timings. */
const LIVENESS_CHECK_INTERVAL_MS = 5_000;
const IDLE_BEFORE_PROBE_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;

/**
 * Liveness is judged on a tick, so a deadline is noticed at the first tick
 * *after* it passes, not the instant it elapses. Tests add a tick of slack
 * rather than assuming the arithmetic lands exactly on a boundary.
 */
const SLACK_MS = LIVENESS_CHECK_INTERVAL_MS * 2;
/** Long enough for a probe to go out AND its deadline to be judged. */
const TIME_TO_DEATH_MS = IDLE_BEFORE_PROBE_MS + PONG_TIMEOUT_MS + SLACK_MS;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = CLOSED;
  }

  /* ---- test drivers ---- */

  /** Completes the handshake. */
  open(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  /** Delivers an inbound frame — the app's only proof of life. */
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** The browser noticing the socket died and telling us. */
  fireClose(): void {
    this.readyState = CLOSED;
    this.onclose?.();
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  pings(): Array<Record<string, unknown>> {
    return this.frames().filter((frame) => frame.type === 'chat.ping');
  }
}

vi.mock('../components/auth/context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

function setup() {
  const listener = vi.fn();
  const view = renderHook(() => useWebSocket(), {
    wrapper: ({ children }) => <WebSocketProvider>{children}</WebSocketProvider>,
  });
  act(() => {
    view.result.current.subscribe(listener);
  });
  return { ...view, listener };
}

/** The socket the provider most recently created. */
function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('no socket was created');
  return socket;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('probing a silent socket', () => {
  it('sends a liveness probe once the socket has been quiet', async () => {
    setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    expect(socket.pings()).toHaveLength(0);

    await advance(IDLE_BEFORE_PROBE_MS + 1_000);
    expect(socket.pings()).toHaveLength(1);
  });

  it('never probes a socket that is actively receiving frames', async () => {
    setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    // A streaming run: frames keep arriving well inside the idle threshold.
    for (let i = 0; i < 10; i += 1) {
      await advance(5_000);
      await act(async () => socket.deliver({ kind: 'assistant', seq: i }));
    }

    expect(socket.pings()).toHaveLength(0);
    expect(socket.closeCalls).toBe(0);
  });

  it('does not stack probes while one is already outstanding', async () => {
    setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    await advance(IDLE_BEFORE_PROBE_MS + 1_000);
    // Still inside the pong deadline: the checker runs repeatedly but must not
    // send a second probe.
    await advance(PONG_TIMEOUT_MS - 2_000);

    expect(socket.pings()).toHaveLength(1);
  });
});

describe('a half-open socket — the #389 case', () => {
  it('tears down and reconnects when a probe goes unanswered', async () => {
    const { result } = setup();
    const dead = latestSocket();
    await act(async () => dead.open());
    expect(result.current.isConnected).toBe(true);

    // The socket is black-holed: it still reports OPEN and accepts writes, but
    // nothing comes back. Before this fix, nothing in the app ever noticed.
    await advance(IDLE_BEFORE_PROBE_MS + LIVENESS_CHECK_INTERVAL_MS);
    expect(dead.pings()).toHaveLength(1);
    expect(dead.readyState).toBe(OPEN); // still "open" — the whole problem

    await advance(PONG_TIMEOUT_MS + SLACK_MS);

    expect(dead.closeCalls).toBe(1);
    expect(result.current.isConnected).toBe(false);

    // And it comes back on its own, rather than waiting for a page reload.
    await advance(RECONNECT_DELAY_MS + SLACK_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const replacement = latestSocket();
    expect(replacement).not.toBe(dead);
    await act(async () => replacement.open());
    expect(result.current.isConnected).toBe(true);
  });

  it('reports the socket as unwritable once it is declared dead', async () => {
    const { result } = setup();
    const dead = latestSocket();
    await act(async () => dead.open());

    expect(result.current.sendMessage({ type: 'chat.send' })).toBe(true);

    await advance(TIME_TO_DEATH_MS);

    // The critical half: a send must now FAIL rather than silently evaporate,
    // so the pending-send store keeps the message instead of believing it left.
    expect(result.current.sendMessage({ type: 'chat.send' })).toBe(false);
  });

  it('keeps the socket when the probe is answered', async () => {
    const { result } = setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    await advance(IDLE_BEFORE_PROBE_MS + 1_000);
    await act(async () => socket.deliver({ kind: 'pong' }));

    await advance(PONG_TIMEOUT_MS + 5_000);

    expect(socket.closeCalls).toBe(0);
    expect(result.current.isConnected).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('accepts any inbound frame as proof of life, not just a pong', async () => {
    setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    await advance(IDLE_BEFORE_PROBE_MS + 1_000);
    await act(async () => socket.deliver({ kind: 'assistant', content: 'hi' }));
    await advance(PONG_TIMEOUT_MS + 5_000);

    expect(socket.closeCalls).toBe(0);
  });
});

describe('probe frames stay out of the application', () => {
  it('does not dispatch pong frames to subscribers', async () => {
    const { listener } = setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    await act(async () => socket.deliver({ kind: 'pong' }));
    expect(listener).not.toHaveBeenCalled();

    await act(async () => socket.deliver({ kind: 'assistant' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('swallows an older server rejecting the probe it does not know', async () => {
    const { listener } = setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    // A server predating `chat.ping` answers with a protocol error. Dispatching
    // it would render an error message into the conversation and stop the
    // spinner, so a version skew must not be user-visible.
    await act(async () => socket.deliver({
      kind: 'protocol_error',
      code: 'UNKNOWN_MESSAGE_TYPE',
      type: 'chat.ping',
      error: 'Unknown message type "chat.ping".',
    }));

    expect(listener).not.toHaveBeenCalled();
  });

  it('still dispatches protocol errors that are about real requests', async () => {
    const { listener } = setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    await act(async () => socket.deliver({
      kind: 'protocol_error',
      code: 'SESSION_NOT_FOUND',
      error: 'nope',
    }));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('resuming from background', () => {
  it('probes immediately when the tab becomes visible again', async () => {
    setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    expect(socket.pings()).toHaveLength(0);

    // Returning to a tab is the single most likely moment to be holding a dead
    // socket, so it must not wait out the idle threshold first.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(socket.pings()).toHaveLength(1);
  });

  it('probes when the network comes back', async () => {
    setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    expect(socket.pings()).toHaveLength(1);
  });

  it('a resume probe that goes unanswered still reconnects', async () => {
    const { result } = setup();
    const dead = latestSocket();
    await act(async () => dead.open());

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await advance(PONG_TIMEOUT_MS + SLACK_MS);

    expect(dead.closeCalls).toBe(1);
    expect(result.current.isConnected).toBe(false);

    await advance(RECONNECT_DELAY_MS + SLACK_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('socket identity', () => {
  it('ignores a stale socket closing after it has been replaced', async () => {
    const { result } = setup();
    const first = latestSocket();
    await act(async () => first.open());

    // Kill the first socket and let the replacement connect.
    await advance(TIME_TO_DEATH_MS);
    await advance(RECONNECT_DELAY_MS + SLACK_MS);
    const second = latestSocket();
    expect(second).not.toBe(first);
    await act(async () => second.open());
    expect(result.current.isConnected).toBe(true);

    // The browser finally gets around to reporting the first socket's close.
    // That must not disturb the live socket that replaced it.
    await act(async () => first.fireClose());

    expect(result.current.isConnected).toBe(true);
    expect(result.current.sendMessage({ type: 'chat.send' })).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('reconnects when the live socket closes normally', async () => {
    const { result } = setup();
    const socket = latestSocket();
    await act(async () => socket.open());

    await act(async () => socket.fireClose());
    expect(result.current.isConnected).toBe(false);

    await advance(RECONNECT_DELAY_MS + SLACK_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
