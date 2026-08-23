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

import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

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
  const subscribe = (fn: (event: ServerEvent) => void) => {
    listener = fn;
    return () => {
      listener = null;
    };
  };

  renderHook(() => {
    const streamTimerRef = useRef<number | null>(null);
    const accumulatedStreamRef = useRef('');
    const lastSeqRef = useRef(new Map<string, number>());
    const statusCheckSentAtRef = useRef(new Map<string, number>());

    useChatRealtimeHandlers({
      subscribe,
      provider: 'claude' as LLMProvider,
      selectedSession: { id: SESSION } as ProjectSession,
      currentSessionId: SESSION,
      setTokenBudget: vi.fn(),
      pendingPermissionRequests: [],
      setPendingPermissionRequests: vi.fn(),
      streamTimerRef,
      accumulatedStreamRef,
      lastSeqRef,
      statusCheckSentAtRef,
      sessionStore: makeSessionStore(),
    });
  });

  return {
    deliver: (event: ServerEvent) => listener?.(event),
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
  localStorage.clear();
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
