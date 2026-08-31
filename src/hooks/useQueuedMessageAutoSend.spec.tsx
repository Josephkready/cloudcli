import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readQueuedMessages, writeQueuedMessages } from '../components/chat/utils/chatStorage';
import { readPendingSends } from '../components/chat/utils/pendingSends';

import { useQueuedMessageAutoSend } from './useQueuedMessageAutoSend';
import type { SessionActivity, SessionActivityMap } from './useSessionProtection';

/*
 * Regression locks for the app-level queued-message auto-send (the sender for
 * sessions the user is NOT currently viewing):
 *
 *  - #63: the queue is an ordered FIFO — queuing A then B keeps BOTH, and each
 *    run completion drains exactly one, head-first, persisting the tail.
 *  - #64: a message is never dropped when it can't be sent — if the socket is
 *    closed the queue is preserved (not cleared "before send"), so a later
 *    completion (or the composer) can retry it.
 */

const WS_OPEN = 1;
const WS_CLOSED = 3;

// jsdom does not implement WebSocket, but the hook reads `WebSocket.OPEN`.
beforeEach(() => {
  // The pending-send store persists across tests within the jsdom localStorage,
  // so clear it (and any queued messages) to keep each case isolated.
  localStorage.clear();
  vi.stubGlobal('WebSocket', class {
    static OPEN = WS_OPEN;
    static CLOSED = WS_CLOSED;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function activity(): SessionActivity {
  return { statusText: null, canInterrupt: true, startedAt: 0, blocked: false };
}
function processing(...ids: string[]): SessionActivityMap {
  return new Map(ids.map((id) => [id, activity()]));
}
function fakeWs(readyState: number) {
  return { readyState } as unknown as WebSocket;
}

type Args = Parameters<typeof useQueuedMessageAutoSend>[0];

function mountAutoSend(overrides: Partial<Args>) {
  // Production sendMessage returns whether the frame reached the socket; the hook
  // now gates the pending-record promotion and the processing band on that, so a
  // truthy default mirrors a healthy socket. Individual tests override it.
  const sendMessage = vi.fn<Args['sendMessage']>(() => true);
  const markSessionProcessing = vi.fn();
  const props: Args = {
    processingSessions: processing(),
    activeSessionId: null,
    ws: fakeWs(WS_OPEN),
    sendMessage,
    markSessionProcessing,
    ...overrides,
  };
  const utils = renderHook((p: Args) => useQueuedMessageAutoSend(p), { initialProps: props });
  return { ...utils, sendMessage, markSessionProcessing, props };
}

// A run for `sessionId` completes: it was in the processing map, now it leaves.
function completeRun(
  rerender: (p: Args) => void,
  base: Args,
  sessionId: string,
) {
  rerender({ ...base, processingSessions: processing(sessionId) });
  rerender({ ...base, processingSessions: processing() });
}

describe('useQueuedMessageAutoSend', () => {
  it('drains a two-item queue FIFO — one message per completion, head first (#63)', () => {
    writeQueuedMessages('s1', [
      { content: 'first', options: { model: 'a' } },
      { content: 'second', options: { model: 'b' } },
    ]);

    const { rerender, sendMessage, props } = mountAutoSend({ ws: fakeWs(WS_OPEN) });

    // First completion drains the HEAD only; the tail stays queued.
    completeRun(rerender, props, 's1');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: 'chat.send',
      sessionId: 's1',
      content: 'first',
      options: { model: 'a', images: [] },
      clientMessageId: expect.any(String),
    });
    expect(readQueuedMessages('s1')).toEqual([{ content: 'second', options: { model: 'b' } }]);

    // Second completion drains the next item; the queue is now empty.
    completeRun(rerender, props, 's1');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: 'chat.send',
      sessionId: 's1',
      content: 'second',
      options: { model: 'b', images: [] },
      clientMessageId: expect.any(String),
    });
    expect(readQueuedMessages('s1')).toEqual([]);
  });

  it('preserves the queue when the socket is closed — never drops the message (#64)', () => {
    writeQueuedMessages('s1', [{ content: 'first' }, { content: 'second' }]);

    const { rerender, sendMessage, markSessionProcessing, props } = mountAutoSend({ ws: fakeWs(WS_CLOSED) });

    completeRun(rerender, props, 's1');

    // Nothing was sent, and — critically — nothing was cleared: the full FIFO
    // survives so a later completion (or the composer) can retry it.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markSessionProcessing).not.toHaveBeenCalled();
    expect(readQueuedMessages('s1')).toEqual([{ content: 'first' }, { content: 'second' }]);
  });

  it('preserves the queue when there is no socket at all (#64)', () => {
    writeQueuedMessages('s1', [{ content: 'only' }]);

    const { rerender, sendMessage, props } = mountAutoSend({ ws: null });

    completeRun(rerender, props, 's1');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(readQueuedMessages('s1')).toEqual([{ content: 'only' }]);
  });

  it('never auto-sends the queue of the currently-viewed session (owned by the composer)', () => {
    writeQueuedMessages('s1', [{ content: 'first' }]);

    const { rerender, sendMessage, props } = mountAutoSend({ ws: fakeWs(WS_OPEN), activeSessionId: 's1' });

    completeRun(rerender, props, 's1');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(readQueuedMessages('s1')).toEqual([{ content: 'first' }]);
  });

  it('marks the session processing after dispatching so its band stays live', () => {
    writeQueuedMessages('s1', [{ content: 'first' }]);

    const { rerender, markSessionProcessing, props } = mountAutoSend({ ws: fakeWs(WS_OPEN) });

    completeRun(rerender, props, 's1');

    expect(markSessionProcessing).toHaveBeenCalledWith('s1', { statusText: null, canInterrupt: true });
  });

  it('gives the auto-send a clientMessageId and a durable, dispatched pending record (#459)', () => {
    writeQueuedMessages('s1', [{ content: 'first', options: { model: 'a' } }]);

    const { rerender, sendMessage, props } = mountAutoSend({ ws: fakeWs(WS_OPEN) });

    completeRun(rerender, props, 's1');

    // The frame carries the id the server dedupes and acks on.
    const frame = sendMessage.mock.calls[0][0] as { clientMessageId: string };
    expect(typeof frame.clientMessageId).toBe('string');
    expect(frame.clientMessageId.length).toBeGreaterThan(0);

    // A durable pending record exists under the same id, so a frame lost on a
    // half-open socket is recoverable by retryPendingSends. It was promoted to
    // dispatched after the socket accepted it (dispatched:true round-trips as an
    // absent field, the store's "assumed dispatched" convention).
    const pending = readPendingSends('s1');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(frame.clientMessageId);
    expect(pending[0].content).toBe('first');
    expect(pending[0].dispatched).not.toBe(false);
  });

  it('keeps a refused send durable as undelivered and does not mark it processing (#459)', () => {
    writeQueuedMessages('s1', [{ content: 'only' }]);

    // A socket that reads OPEN but refuses the frame (returns false) — the
    // half-open case. The message must survive as an undelivered pending record
    // and the session must NOT be shown as processing.
    const refusedSend = vi.fn(() => false);
    const markSessionProcessing = vi.fn();
    const { rerender, props } = mountAutoSend({
      ws: fakeWs(WS_OPEN),
      sendMessage: refusedSend,
      markSessionProcessing,
    });

    completeRun(rerender, props, 's1');

    expect(refusedSend).toHaveBeenCalledTimes(1);
    expect(markSessionProcessing).not.toHaveBeenCalled();

    const pending = readPendingSends('s1');
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe('only');
    expect(pending[0].dispatched).toBe(false);
  });
});
