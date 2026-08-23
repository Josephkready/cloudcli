import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import type { SessionStore } from '../../../stores/useSessionStore';
import type { LLMProvider, ProjectSession } from '../../../types/app';
import {
  appendPendingSend,
  readPendingSends,
  writePendingSends,
} from '../utils/pendingSends';

import {
  clearStreamingStates,
  useChatRealtimeHandlers,
  type StreamingState,
} from './useChatRealtimeHandlers';

/**
 * The client half of the `chat_send_accepted` delivery ack (#389).
 *
 * WHY THIS SUITE EXISTS. The server now confirms a `chat.send` the moment it
 * owns the message — queued or started — and this handler is what acts on that
 * confirmation by retiring the durable pending-send entry. If it silently
 * stopped working, nothing else would fail: the entry would linger, the 30s
 * resend grace would expire, and the next reconnect would send the message a
 * second time. That is exactly the bug #389 reports, so the handler cannot be
 * left to a coverage gap.
 */

const SESSION = 'session-1';
const OTHER_SESSION = 'session-2';

function makeSessionStore(): SessionStore {
  return {
    appendRealtime: vi.fn(),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    refreshFromServer: vi.fn(),
    getSessionSlot: vi.fn(),
    has: vi.fn(),
    isStale: vi.fn(),
    fetchFromServer: vi.fn(),
  } as unknown as SessionStore;
}

/**
 * Renders the hook and hands back a function that pushes a frame through the
 * same `subscribe` channel the websocket provider uses.
 */
function setup() {
  let listener: ((event: ServerEvent) => void) | null = null;
  let activeSessionId = SESSION;
  const sessionStore = makeSessionStore();
  const subscribe = (fn: (event: ServerEvent) => void) => {
    listener = fn;
    return () => {
      listener = null;
    };
  };

  const { rerender } = renderHook(() => {
    const streamingStatesRef = useRef(new Map());
    const lastSeqRef = useRef(new Map<string, number>());
    const statusCheckSentAtRef = useRef(new Map<string, number>());

    useChatRealtimeHandlers({
      subscribe,
      provider: 'claude' as LLMProvider,
      selectedSession: { id: activeSessionId } as ProjectSession,
      currentSessionId: activeSessionId,
      setTokenBudget: vi.fn(),
      pendingPermissionRequests: [],
      setPendingPermissionRequests: vi.fn(),
      streamingStatesRef,
      lastSeqRef,
      statusCheckSentAtRef,
      sessionStore,
    });
  });

  return {
    deliver: (event: ServerEvent) => listener?.(event),
    sessionStore,
    selectSession: (sessionId: string) => {
      activeSessionId = sessionId;
      rerender();
    },
  };
}

const pendingIds = (sessionId: string) => readPendingSends(sessionId).map((entry) => entry.id);

function seedPending(sessionId: string, id: string, content = 'hello'): void {
  appendPendingSend(sessionId, {
    id,
    content,
    timestamp: new Date().toISOString(),
    dispatched: true,
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('stream buffering', () => {
  it('keeps interleaved sessions in separate accumulated messages', () => {
    vi.useFakeTimers();
    const { deliver, sessionStore } = setup();

    deliver({ kind: 'stream_delta', sessionId: SESSION, content: 'A1' });
    deliver({ kind: 'stream_delta', sessionId: OTHER_SESSION, content: 'B1' });
    deliver({ kind: 'stream_delta', sessionId: SESSION, content: 'A2' });
    vi.advanceTimersByTime(100);

    expect(sessionStore.updateStreaming).toHaveBeenCalledWith(SESSION, 'A1A2', 'claude');
    expect(sessionStore.updateStreaming).toHaveBeenCalledWith(OTHER_SESSION, 'B1', 'claude');
    expect(sessionStore.appendRealtime).not.toHaveBeenCalled();
  });

  it('keeps a pending background-session buffer when the active view changes', () => {
    vi.useFakeTimers();
    const { deliver, selectSession, sessionStore } = setup();

    deliver({ kind: 'stream_delta', sessionId: SESSION, content: 'before switch' });
    selectSession(OTHER_SESSION);
    vi.advanceTimersByTime(100);

    expect(sessionStore.updateStreaming).toHaveBeenCalledWith(
      SESSION,
      'before switch',
      'claude',
    );
  });

  it('finalizes only the session named by stream_end', () => {
    vi.useFakeTimers();
    const { deliver, sessionStore } = setup();

    deliver({ kind: 'stream_delta', sessionId: SESSION, content: 'A' });
    deliver({ kind: 'stream_delta', sessionId: OTHER_SESSION, content: 'B' });
    deliver({ kind: 'stream_end', sessionId: SESSION });
    vi.advanceTimersByTime(100);

    expect(sessionStore.updateStreaming).toHaveBeenCalledWith(SESSION, 'A', 'claude');
    expect(sessionStore.finalizeStreaming).toHaveBeenCalledWith(SESSION);
    expect(sessionStore.updateStreaming).toHaveBeenCalledWith(OTHER_SESSION, 'B', 'claude');
    expect(sessionStore.finalizeStreaming).not.toHaveBeenCalledWith(OTHER_SESSION);
  });

  it('uses each stream event provider for background-session metadata', () => {
    vi.useFakeTimers();
    const { deliver, sessionStore } = setup();

    deliver({
      kind: 'stream_delta',
      sessionId: OTHER_SESSION,
      provider: 'codex',
      content: 'from codex',
    });
    vi.advanceTimersByTime(100);

    expect(sessionStore.updateStreaming).toHaveBeenCalledWith(
      OTHER_SESSION,
      'from codex',
      'codex',
    );
  });

  it('clears every pending stream timer during owner cleanup', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const streamingStates = new Map<string, StreamingState>([
      [SESSION, {
        accumulatedText: 'pending',
        timer: window.setTimeout(callback, 100),
        provider: 'claude',
      }],
      [OTHER_SESSION, {
        accumulatedText: 'also pending',
        timer: window.setTimeout(callback, 100),
        provider: 'codex',
      }],
    ]);

    clearStreamingStates(streamingStates);
    vi.advanceTimersByTime(100);

    expect(callback).not.toHaveBeenCalled();
    expect(streamingStates.size).toBe(0);
  });
});

describe('chat_send_accepted', () => {
  it('retires the acknowledged entry from the pending store', () => {
    seedPending(SESSION, 'pending_1');
    expect(pendingIds(SESSION)).toEqual(['pending_1']);

    const { deliver } = setup();
    deliver({ kind: 'chat_send_accepted', sessionId: SESSION, clientMessageId: 'pending_1' });

    expect(pendingIds(SESSION)).toEqual([]);
  });

  it('retires only the acknowledged entry, leaving the rest queued', () => {
    seedPending(SESSION, 'pending_1', 'one');
    seedPending(SESSION, 'pending_2', 'two');
    seedPending(SESSION, 'pending_3', 'three');

    const { deliver } = setup();
    deliver({ kind: 'chat_send_accepted', sessionId: SESSION, clientMessageId: 'pending_2' });

    // The other two are still unconfirmed and must stay resendable.
    expect(pendingIds(SESSION)).toEqual(['pending_1', 'pending_3']);
  });

  it('does not touch an entry belonging to a different session', () => {
    seedPending(OTHER_SESSION, 'pending_1');

    const { deliver } = setup();
    deliver({ kind: 'chat_send_accepted', sessionId: SESSION, clientMessageId: 'pending_1' });

    // Ids are only unique within one client's storage, so the same id can exist
    // in two sessions. Keying the removal on the frame's session is what keeps
    // an ack for one conversation from discarding another's unsent message.
    expect(pendingIds(OTHER_SESSION)).toEqual(['pending_1']);
  });

  it('is inert when the id does not match anything pending', () => {
    seedPending(SESSION, 'pending_1');

    const { deliver } = setup();
    deliver({ kind: 'chat_send_accepted', sessionId: SESSION, clientMessageId: 'pending_unknown' });

    expect(pendingIds(SESSION)).toEqual(['pending_1']);
  });

  it('ignores a malformed ack rather than clearing the queue', () => {
    seedPending(SESSION, 'pending_1');

    const { deliver } = setup();
    // No clientMessageId at all — must not be read as "remove everything".
    deliver({ kind: 'chat_send_accepted', sessionId: SESSION });
    expect(pendingIds(SESSION)).toEqual(['pending_1']);

    deliver({ kind: 'chat_send_accepted', sessionId: SESSION, clientMessageId: 42 });
    expect(pendingIds(SESSION)).toEqual(['pending_1']);
  });

  it('falls back to the viewed session when the ack omits one', () => {
    seedPending(SESSION, 'pending_1');

    const { deliver } = setup();
    deliver({ kind: 'chat_send_accepted', clientMessageId: 'pending_1' });

    expect(pendingIds(SESSION)).toEqual([]);
  });

  it('leaves the pending store alone for unrelated frames', () => {
    seedPending(SESSION, 'pending_1');

    const { deliver } = setup();
    deliver({ kind: 'assistant', sessionId: SESSION, content: 'hi' });
    deliver({ kind: 'complete', sessionId: SESSION });

    expect(pendingIds(SESSION)).toEqual(['pending_1']);
  });

  it('survives a queue that was never written', () => {
    writePendingSends(SESSION, []);

    const { deliver } = setup();
    expect(() =>
      deliver({ kind: 'chat_send_accepted', sessionId: SESSION, clientMessageId: 'pending_1' }),
    ).not.toThrow();
  });
});
