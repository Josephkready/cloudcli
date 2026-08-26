import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import type { SessionStore } from '../../../stores/useSessionStore';
import type { LLMProvider, ProjectSession } from '../../../types/app';

import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

/**
 * #450 — what is allowed to become a transcript row.
 *
 * The persist rule used to be an EXCLUDE-list of four control kinds, so any
 * frame the client did not recognise was cast to a `NormalizedMessage` and
 * appended to the session store. The chat socket carries gateway frames as well
 * as provider messages, and gateway frames are hand-rolled — they carry no
 * `id`. An id-less row made the store's merge throw, and because the row was
 * already in the slot by then, the session stayed broken.
 *
 * `chat_resumed` is the one that bit: it is emitted on every `chat.resume`, so
 * a single click of the interrupted-run banner poisoned the viewed session.
 *
 * The rule is now an allow-list, which inverts the failure mode: an unknown
 * frame is dropped instead of stored. That trade is only safe if the list is
 * complete, so the second suite below pins every kind that must still persist.
 */

const SESSION = 'session-1';

function makeSessionStore(): SessionStore {
  return {
    appendRealtime: vi.fn(),
    appendRealtimeBatch: vi.fn(),
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
      selectedSession: { id: SESSION } as ProjectSession,
      currentSessionId: SESSION,
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
    appendRealtime: sessionStore.appendRealtime as ReturnType<typeof vi.fn>,
    updateStreaming: sessionStore.updateStreaming as ReturnType<typeof vi.fn>,
    finalizeStreaming: sessionStore.finalizeStreaming as ReturnType<typeof vi.fn>,
  };
}

const persistedKinds = (appendRealtime: ReturnType<typeof vi.fn>): string[] =>
  appendRealtime.mock.calls.map(([, message]) => (message as { kind?: string })?.kind ?? '');

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('gateway frames never reach the transcript (#450)', () => {
  it('does not persist chat_resumed', () => {
    const { deliver, appendRealtime } = setup();

    // Verbatim shape from chat-websocket.service.ts:581 / :656 — note the
    // missing `id`, which is what the merge used to dereference.
    deliver({
      kind: 'chat_resumed',
      sessionId: SESSION,
      resumed: 1,
      timestamp: '2026-08-25T03:05:56.000Z',
    });

    expect(appendRealtime).not.toHaveBeenCalled();
  });

  it.each([
    ['chat_subscribed', { isProcessing: false }],
    ['chat_send_accepted', { clientMessageId: 'pending_1' }],
    ['pong', {}],
    ['session_upserted', {}],
    ['loading_progress', {}],
    ['projects_snapshot_stale', {}],
    ['websocket_reconnected', {}],
  ])('does not persist %s', (kind, extra) => {
    const { deliver, appendRealtime } = setup();
    deliver({ kind, sessionId: SESSION, ...extra } as ServerEvent);
    expect(appendRealtime).not.toHaveBeenCalled();
  });

  it('does not persist the protocol_error frame itself', () => {
    const { deliver, appendRealtime } = setup();
    deliver({ kind: 'protocol_error', sessionId: SESSION, code: 'bad_request', error: 'nope' });

    // This one is deliberately different: the handler surfaces the failure by
    // synthesizing its OWN error row (with a real id) rather than storing the
    // gateway frame. That distinction is the whole point — a frame the client
    // constructs is safe, a frame it forwards verbatim is not.
    expect(persistedKinds(appendRealtime)).toEqual(['error']);
    expect(appendRealtime).toHaveBeenCalledWith(SESSION, expect.objectContaining({
      kind: 'error',
      content: 'nope',
      id: expect.stringMatching(/^protocol_error_/),
    }));
  });

  it('drops a kind nobody has ever seen, instead of storing it', () => {
    const { deliver, appendRealtime } = setup();
    deliver({ kind: 'some_future_gateway_frame', sessionId: SESSION });
    expect(appendRealtime).not.toHaveBeenCalled();
  });

  it('says so, so a genuinely new provider kind is not lost in silence', () => {
    const { deliver } = setup();
    // Randomised: the warn-once cache is module state shared across tests.
    const kind = `unheard_of_${Math.random().toString(36).slice(2)}`;
    deliver({ kind, sessionId: SESSION });

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(kind));
  });

  it('stays quiet about control frames it drops on purpose', () => {
    const { deliver } = setup();
    deliver({ kind: 'chat_resumed', sessionId: SESSION, resumed: 1 });
    deliver({ kind: 'complete', sessionId: SESSION, exitCode: 0 });

    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('real messages still reach the transcript (#450)', () => {
  it('persists a user message', () => {
    const { deliver, appendRealtime } = setup();
    deliver({
      kind: 'text',
      id: 'msg_1',
      sessionId: SESSION,
      role: 'user',
      content: 'hello',
      provider: 'claude',
    });

    expect(appendRealtime).toHaveBeenCalledWith(SESSION, expect.objectContaining({
      id: 'msg_1',
      kind: 'text',
      role: 'user',
    }));
  });

  it('persists an assistant message', () => {
    const { deliver, appendRealtime } = setup();
    deliver({
      kind: 'text',
      id: 'msg_2',
      sessionId: SESSION,
      role: 'assistant',
      content: 'hi there',
      provider: 'claude',
    });

    expect(appendRealtime).toHaveBeenCalledWith(SESSION, expect.objectContaining({
      id: 'msg_2',
      role: 'assistant',
    }));
  });

  /**
   * The narrowing guard.
   *
   * An allow-list that misses a kind drops real messages silently, which is a
   * worse bug than the crash it replaces. This list is `MessageKind` — the
   * union mirrored from `server/shared/types.ts` — minus the four control kinds
   * the hook consumes as events. Every entry is minted by
   * `createNormalizedMessage` (server) or `chatMessageToNormalized` (client),
   * both of which guarantee an `id`.
   *
   * If someone adds a kind to `MessageKind` without adding it to the allow-list,
   * the kind will not appear here either — so pair this with the console warning
   * above, which is what catches an unlisted kind at runtime.
   */
  it.each([
    'text',
    'tool_use',
    'tool_result',
    'thinking',
    'error',
    'session_created',
    'interactive_prompt',
    'task_notification',
  ])('persists %s', (kind) => {
    const { deliver, appendRealtime } = setup();
    deliver({ kind, id: `msg_${kind}`, sessionId: SESSION, provider: 'claude' });

    expect(persistedKinds(appendRealtime)).toContain(kind);
  });

  it('still streams a stream_delta into the store', () => {
    // `stream_delta` reaches the store through the buffered `updateStreaming`
    // path rather than a raw append, so the allow-list check above cannot see
    // it. Assert the text lands, or a narrowed list would silently stop live
    // assistant output from ever rendering.
    vi.useFakeTimers();
    const { deliver, updateStreaming } = setup();

    deliver({ kind: 'stream_delta', id: 'd1', sessionId: SESSION, content: 'partial' });
    vi.advanceTimersByTime(100);

    expect(updateStreaming).toHaveBeenCalledWith(SESSION, 'partial', 'claude');
  });

  it('still finalizes a stream_end', () => {
    // Same story as stream_delta: intercepted before the persist check and
    // routed to `finalizeStreaming`. Asserted so a change to the persist policy
    // that also broke the streaming path could not pass unnoticed.
    vi.useFakeTimers();
    const { deliver, finalizeStreaming } = setup();

    deliver({ kind: 'stream_delta', id: 'd1', sessionId: SESSION, content: 'partial' });
    deliver({ kind: 'stream_end', id: 'e1', sessionId: SESSION });

    expect(finalizeStreaming).toHaveBeenCalledWith(SESSION);
  });
});

describe('control frames are still consumed as events, not rows', () => {
  it.each(['complete', 'status', 'permission_request', 'permission_cancelled'])(
    'does not persist %s',
    (kind) => {
      const { deliver, appendRealtime } = setup();
      deliver({ kind, id: `msg_${kind}`, sessionId: SESSION, provider: 'claude' });
      expect(persistedKinds(appendRealtime)).not.toContain(kind);
    },
  );
});
