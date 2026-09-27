import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import type { SessionStore } from '../../../stores/useSessionStore';
import type { LLMProvider, ProjectSession } from '../../../types/app';
import type { PendingPermissionRequest } from '../types/types';

import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

/**
 * `permission_request` / `permission_cancelled` / `status` frame handling —
 * the menu and token-budget side of the realtime dispatcher that the ack,
 * persistPolicy and tokenBudget suites don't touch.
 */

const mockPlayNotificationSound = vi.fn();
vi.mock('../../../utils/notificationSound', () => ({
  playNotificationSound: (...args: unknown[]) => mockPlayNotificationSound(...args),
  playChatCompletionSound: vi.fn(),
}));

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

function setup() {
  let listener: ((event: ServerEvent) => void) | null = null;
  const sessionStore = makeSessionStore();
  const setTokenBudget = vi.fn();
  const setPendingPermissionRequests = vi.fn();
  const onSessionProcessing = vi.fn();
  const subscribe = (fn: (event: ServerEvent) => void) => {
    listener = fn;
    return () => {
      listener = null;
    };
  };

  let pendingPermissionRequests: PendingPermissionRequest[] = [];

  const rendered = renderHook(() => {
    const streamingStatesRef = useRef(new Map());
    const lastSeqRef = useRef(new Map<string, number>());
    const statusCheckSentAtRef = useRef(new Map<string, number>());

    useChatRealtimeHandlers({
      subscribe,
      provider: 'claude' as LLMProvider,
      selectedSession: { id: SESSION } as ProjectSession,
      currentSessionId: SESSION,
      setTokenBudget,
      pendingPermissionRequests,
      setPendingPermissionRequests: (next) => {
        pendingPermissionRequests =
          typeof next === 'function' ? next(pendingPermissionRequests) : next;
        setPendingPermissionRequests(pendingPermissionRequests);
      },
      streamingStatesRef,
      lastSeqRef,
      statusCheckSentAtRef,
      onSessionProcessing,
      sessionStore,
    });
  });

  return {
    deliver: (event: ServerEvent) => listener?.(event),
    rendered,
    sessionStore,
    setTokenBudget,
    setPendingPermissionRequests,
    onSessionProcessing,
    getPending: () => pendingPermissionRequests,
  };
}

beforeEach(() => {
  mockPlayNotificationSound.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('permission_request', () => {
  it('ignores a frame with no requestId', () => {
    const { deliver, setPendingPermissionRequests } = setup();
    deliver({ kind: 'permission_request', sessionId: SESSION, toolName: 'Bash' });
    expect(setPendingPermissionRequests).not.toHaveBeenCalled();
  });

  it('plays a notification sound for an actionable tool', () => {
    const { deliver } = setup();
    deliver({ kind: 'permission_request', sessionId: SESSION, requestId: 'req-1', toolName: 'Bash' });
    expect(mockPlayNotificationSound).toHaveBeenCalled();
  });

  it('does not play a sound for ExitPlanMode (not actionable)', () => {
    const { deliver } = setup();
    deliver({ kind: 'permission_request', sessionId: SESSION, requestId: 'req-1', toolName: 'ExitPlanMode' });
    expect(mockPlayNotificationSound).not.toHaveBeenCalled();
  });

  it('adds the request to the pending list for the viewed session', () => {
    const { deliver, setPendingPermissionRequests, onSessionProcessing } = setup();
    deliver({
      kind: 'permission_request',
      sessionId: SESSION,
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });

    expect(setPendingPermissionRequests).toHaveBeenCalledWith([
      expect.objectContaining({ requestId: 'req-1', toolName: 'Bash', sessionId: SESSION }),
    ]);
    expect(onSessionProcessing).toHaveBeenCalledWith(SESSION);
  });

  it('does not duplicate an already-pending requestId', () => {
    const { deliver, setPendingPermissionRequests } = setup();
    deliver({ kind: 'permission_request', sessionId: SESSION, requestId: 'req-1', toolName: 'Bash' });
    setPendingPermissionRequests.mockClear();

    deliver({ kind: 'permission_request', sessionId: SESSION, requestId: 'req-1', toolName: 'Bash' });

    expect(setPendingPermissionRequests).not.toHaveBeenCalled();
  });

  it('ignores requests for a session other than the one being viewed, in the menu, but still marks it processing', () => {
    const { deliver, setPendingPermissionRequests, onSessionProcessing } = setup();
    deliver({ kind: 'permission_request', sessionId: OTHER_SESSION, requestId: 'req-2', toolName: 'Bash' });

    expect(setPendingPermissionRequests).not.toHaveBeenCalled();
    expect(onSessionProcessing).toHaveBeenCalledWith(OTHER_SESSION);
  });

  it('defaults toolName to UnknownTool when absent', () => {
    const { deliver, setPendingPermissionRequests } = setup();
    deliver({ kind: 'permission_request', sessionId: SESSION, requestId: 'req-1' });

    expect(setPendingPermissionRequests).toHaveBeenCalledWith([
      expect.objectContaining({ toolName: 'UnknownTool' }),
    ]);
  });
});

describe('permission_cancelled', () => {
  it('removes a matching pending request for the viewed session', () => {
    const { deliver, setPendingPermissionRequests } = setup();
    deliver({ kind: 'permission_request', sessionId: SESSION, requestId: 'req-1', toolName: 'Bash' });
    setPendingPermissionRequests.mockClear();

    deliver({ kind: 'permission_cancelled', sessionId: SESSION, requestId: 'req-1' });

    expect(setPendingPermissionRequests).toHaveBeenCalledWith([]);
  });

  it('is a no-op without a requestId', () => {
    const { deliver, setPendingPermissionRequests } = setup();
    deliver({ kind: 'permission_request', sessionId: SESSION, requestId: 'req-1', toolName: 'Bash' });
    setPendingPermissionRequests.mockClear();

    deliver({ kind: 'permission_cancelled', sessionId: SESSION });

    expect(setPendingPermissionRequests).not.toHaveBeenCalled();
  });

  it('is a no-op for a different session', () => {
    const { deliver, setPendingPermissionRequests } = setup();
    deliver({ kind: 'permission_request', sessionId: SESSION, requestId: 'req-1', toolName: 'Bash' });
    setPendingPermissionRequests.mockClear();

    deliver({ kind: 'permission_cancelled', sessionId: OTHER_SESSION, requestId: 'req-1' });

    expect(setPendingPermissionRequests).not.toHaveBeenCalled();
  });
});

describe('status frames', () => {
  it('applies a token_budget status for the viewed session', () => {
    const { deliver, setTokenBudget } = setup();
    deliver({
      kind: 'status',
      sessionId: SESSION,
      text: 'token_budget',
      tokenBudget: { inputTokens: 10 },
      seq: 1,
    });

    expect(setTokenBudget).toHaveBeenCalledWith({ inputTokens: 10 });
  });

  it('ignores a stale (lower or equal seq) token_budget update', () => {
    const { deliver, setTokenBudget } = setup();
    deliver({ kind: 'status', sessionId: SESSION, text: 'token_budget', tokenBudget: { inputTokens: 10 }, seq: 5 });
    setTokenBudget.mockClear();

    deliver({ kind: 'status', sessionId: SESSION, text: 'token_budget', tokenBudget: { inputTokens: 1 }, seq: 5 });

    expect(setTokenBudget).not.toHaveBeenCalled();
  });

  it('ignores a token_budget status for a session other than the viewed one', () => {
    const { deliver, setTokenBudget } = setup();
    deliver({
      kind: 'status',
      sessionId: OTHER_SESSION,
      text: 'token_budget',
      tokenBudget: { inputTokens: 10 },
    });

    expect(setTokenBudget).not.toHaveBeenCalled();
  });

  it('forwards a plain status text as a processing update', () => {
    const { deliver, onSessionProcessing } = setup();
    deliver({ kind: 'status', sessionId: SESSION, text: 'Reading files…', canInterrupt: false });

    expect(onSessionProcessing).toHaveBeenCalledWith(SESSION, {
      statusText: 'Reading files…',
      canInterrupt: false,
    });
  });

  it('defaults canInterrupt to true when absent', () => {
    const { deliver, onSessionProcessing } = setup();
    deliver({ kind: 'status', sessionId: SESSION, text: 'Thinking…' });

    expect(onSessionProcessing).toHaveBeenCalledWith(SESSION, {
      statusText: 'Thinking…',
      canInterrupt: true,
    });
  });
});
