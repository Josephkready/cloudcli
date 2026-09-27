import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import type { SessionStore } from '../../../stores/useSessionStore';
import type { LLMProvider, ProjectSession } from '../../../types/app';

import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

/**
 * Regression coverage for #541: a replayed frame must never render twice.
 *
 * `chat.subscribe` asks the server to replay a running run's buffered frames
 * after the subscriber's `lastSeq`. A new session sent that subscribe several
 * times within ~100ms, each still carrying `lastSeq: 0`, so the server
 * (correctly) re-sent the same buffered frames once per subscribe. The handler
 * appended every copy: a `stream_delta` rendered as
 * "chunk 1. chunk 1. chunk 1. chunk 1. chunk 2.", and because that no longer
 * matched the final `text`, the transcript kept both bubbles.
 *
 * A replay is the identical buffered event — same `id` and same `seq` — so that
 * pair identifies it. `seq` alone cannot: the server restarts it at 1 for every
 * run, so the next run legitimately reuses numbers the last one already sent.
 */

const SESSION = 'session-1';

function makeSessionStore() {
  return {
    appendRealtime: vi.fn(),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    refreshFromServer: vi.fn(),
    getSessionSlot: vi.fn(),
    has: vi.fn(),
    isStale: vi.fn(),
    fetchFromServer: vi.fn(),
  };
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
      sessionStore: sessionStore as unknown as SessionStore,
    });
  });

  return {
    sessionStore,
    deliver: (event: ServerEvent) => listener?.(event),
  };
}

function delta(id: string, seq: number, content: string): ServerEvent {
  return { kind: 'stream_delta', id, seq, content, sessionId: SESSION, provider: 'claude' } as unknown as ServerEvent;
}

function text(id: string, seq: number, content: string): ServerEvent {
  return { kind: 'text', role: 'assistant', id, seq, content, sessionId: SESSION, provider: 'claude' } as unknown as ServerEvent;
}

function complete(id: string, seq: number): ServerEvent {
  return { kind: 'complete', id, seq, sessionId: SESSION, provider: 'claude', exitCode: 0 } as unknown as ServerEvent;
}

/** The text the streaming bubble shows after its 100ms flush. */
function streamedText(sessionStore: ReturnType<typeof makeSessionStore>): string | undefined {
  vi.advanceTimersByTime(150);
  return sessionStore.updateStreaming.mock.calls.at(-1)?.[1];
}

describe('replayed realtime frames (#541)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a stream_delta once when the live frame is followed by replays of it', () => {
    const { deliver, sessionStore } = setup();

    // Captured on a real phone: one live frame plus three replays, one per
    // `chat.subscribe {lastSeq: 0}`, then the next chunk.
    deliver(delta('stream_delta_a', 2, 'chunk 1. '));
    deliver(delta('stream_delta_a', 2, 'chunk 1. '));
    deliver(delta('stream_delta_a', 2, 'chunk 1. '));
    deliver(delta('stream_delta_a', 2, 'chunk 1. '));
    deliver(delta('stream_delta_b', 3, 'chunk 2. '));

    expect(streamedText(sessionStore)).toBe('chunk 1. chunk 2. ');
  });

  it('appends a replayed text frame to the store once', () => {
    const { deliver, sessionStore } = setup();

    deliver(text('msg_a', 4, 'hello'));
    deliver(text('msg_a', 4, 'hello'));

    expect(sessionStore.appendRealtime).toHaveBeenCalledTimes(1);
  });

  it("keeps the next run's frames even though its seq restarts at numbers already seen", () => {
    const { deliver, sessionStore } = setup();

    deliver(delta('run1_a', 2, 'first run. '));
    deliver(complete('run1_done', 3));
    sessionStore.updateStreaming.mockClear();

    // The server's registry starts every run at seq 1, so run 2 re-uses 2.
    deliver(delta('run2_a', 2, 'second run. '));

    expect(streamedText(sessionStore)).toBe('second run. ');
  });

  it('keeps a frame that reuses an id under a new seq, since that is a new event', () => {
    const { deliver, sessionStore } = setup();

    deliver(text('msg_a', 4, 'hello'));
    deliver(text('msg_a', 5, 'hello again'));

    expect(sessionStore.appendRealtime).toHaveBeenCalledTimes(2);
  });

  it('does not drop unsequenced frames that happen to repeat', () => {
    const { deliver, sessionStore } = setup();

    // No `seq` means the frame is not from the replay buffer, so there is no
    // basis for calling a repeat a replay.
    const frame = { kind: 'text', role: 'assistant', id: 'plain', content: 'x', sessionId: SESSION } as unknown as ServerEvent;
    deliver(frame);
    deliver(frame);

    expect(sessionStore.appendRealtime).toHaveBeenCalledTimes(2);
  });
});
