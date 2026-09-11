import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import type { SessionStore } from '../../../stores/useSessionStore';
import type { LLMProvider, ProjectSession } from '../../../types/app';

import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

/**
 * Regression coverage for "200,000 tokens, then 50,000" (Joseph's complaint).
 *
 * The live `token_budget` websocket frame updates on every assistant/result
 * usage payload the SDK stream emits — including, before this fix, a
 * subagent's own much smaller usage, and frames for sessions other than the
 * one on screen. This suite pins the two client-side guards that make the
 * per-message update monotonic and session-scoped regardless of what the
 * server sends: a frame is applied only for the viewed session, and only when
 * its `seq` is newer than the last one actually applied.
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

function setup(activeSessionId = SESSION) {
  let listener: ((event: ServerEvent) => void) | null = null;
  const setTokenBudget = vi.fn();
  const subscribe = (fn: (event: ServerEvent) => void) => {
    listener = fn;
    return () => {
      listener = null;
    };
  };

  renderHook(() => {
    const streamingStatesRef = useRef(new Map());
    const lastSeqRef = useRef(new Map<string, number>());
    const statusCheckSentAtRef = useRef(new Map<string, number>());

    useChatRealtimeHandlers({
      subscribe,
      provider: 'claude' as LLMProvider,
      selectedSession: { id: activeSessionId } as ProjectSession,
      currentSessionId: activeSessionId,
      setTokenBudget,
      pendingPermissionRequests: [],
      setPendingPermissionRequests: vi.fn(),
      streamingStatesRef,
      lastSeqRef,
      statusCheckSentAtRef,
      sessionStore: makeSessionStore(),
    });
  });

  return {
    setTokenBudget,
    deliver: (event: ServerEvent) => listener?.(event),
  };
}

function tokenBudgetFrame(sessionId: string, seq: number, used: number): ServerEvent {
  return {
    kind: 'status',
    text: 'token_budget',
    sessionId,
    seq,
    tokenBudget: { inputTokens: used, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  } as unknown as ServerEvent;
}

describe('token_budget realtime handling', () => {
  it('applies a token_budget frame for the viewed session', () => {
    const { deliver, setTokenBudget } = setup(SESSION);

    deliver(tokenBudgetFrame(SESSION, 1, 100_000));

    expect(setTokenBudget).toHaveBeenCalledTimes(1);
    expect(setTokenBudget).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100_000 }),
    );
  });

  it('ignores a token_budget frame for a session that is not being viewed', () => {
    // A subagent turn inside a DIFFERENT session's background run, or simply
    // a background run's own frame — either way it must never touch the
    // number the user is currently looking at.
    const { deliver, setTokenBudget } = setup(SESSION);

    deliver(tokenBudgetFrame(OTHER_SESSION, 1, 50_000));

    expect(setTokenBudget).not.toHaveBeenCalled();
  });

  it('ignores an out-of-order/duplicate frame (seq not newer than the one already applied)', () => {
    const { deliver, setTokenBudget } = setup(SESSION);

    deliver(tokenBudgetFrame(SESSION, 5, 200_000));
    deliver(tokenBudgetFrame(SESSION, 3, 50_000)); // arrived late — must not regress the display
    deliver(tokenBudgetFrame(SESSION, 5, 50_000)); // exact duplicate — also inert

    expect(setTokenBudget).toHaveBeenCalledTimes(1);
    expect(setTokenBudget).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 200_000 }),
    );
  });

  it('applies a strictly newer seq within the same run', () => {
    const { deliver, setTokenBudget } = setup(SESSION);

    deliver(tokenBudgetFrame(SESSION, 1, 10_000));
    deliver(tokenBudgetFrame(SESSION, 2, 20_000));

    expect(setTokenBudget).toHaveBeenCalledTimes(2);
    expect(setTokenBudget).toHaveBeenNthCalledWith(2, expect.objectContaining({ inputTokens: 20_000 }));
  });

  it('accepts the next run\'s first frame even though its seq restarts lower, once `complete` fires', () => {
    const { deliver, setTokenBudget } = setup(SESSION);

    deliver(tokenBudgetFrame(SESSION, 5, 200_000));
    deliver({ kind: 'complete', sessionId: SESSION, success: true } as unknown as ServerEvent);
    deliver(tokenBudgetFrame(SESSION, 1, 10_000)); // new run's own seq count, starting over

    expect(setTokenBudget).toHaveBeenCalledTimes(2);
    expect(setTokenBudget).toHaveBeenNthCalledWith(2, expect.objectContaining({ inputTokens: 10_000 }));
  });

  it('applies a frame with no seq unconditionally (no ordering information to guard on)', () => {
    const { deliver, setTokenBudget } = setup(SESSION);

    deliver({
      kind: 'status',
      text: 'token_budget',
      sessionId: SESSION,
      tokenBudget: { inputTokens: 42, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as unknown as ServerEvent);

    expect(setTokenBudget).toHaveBeenCalledTimes(1);
  });
});
