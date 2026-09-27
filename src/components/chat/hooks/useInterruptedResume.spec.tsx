import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../../../contexts/WebSocketContext';

import { useInterruptedResume } from './useInterruptedResume';

const mockSendMessage = vi.fn();
let listener: ((event: ServerEvent) => void) | null = null;
const mockSubscribe = vi.fn((fn: (event: ServerEvent) => void) => {
  listener = fn;
  return () => {
    listener = null;
  };
});

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: mockSubscribe, sendMessage: mockSendMessage }),
}));

const deliver = (event: ServerEvent) => act(() => listener?.(event));

describe('useInterruptedResume', () => {
  it('starts un-interrupted and stays that way with no session', () => {
    const { result } = renderHook(() => useInterruptedResume(null));
    expect(result.current.interrupted).toBe(false);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('flags interrupted when chat_subscribed reports stranded work', () => {
    const { result } = renderHook(() => useInterruptedResume('session-1'));

    deliver({ kind: 'chat_subscribed', sessionId: 'session-1', interrupted: true, isProcessing: false });

    expect(result.current.interrupted).toBe(true);
  });

  it('ignores events for a different session', () => {
    const { result } = renderHook(() => useInterruptedResume('session-1'));

    deliver({ kind: 'chat_subscribed', sessionId: 'other-session', interrupted: true, isProcessing: false });

    expect(result.current.interrupted).toBe(false);
  });

  it('clears the flag once chat_resumed arrives', () => {
    const { result } = renderHook(() => useInterruptedResume('session-1'));
    deliver({ kind: 'chat_subscribed', sessionId: 'session-1', interrupted: true, isProcessing: false });
    expect(result.current.interrupted).toBe(true);

    deliver({ kind: 'chat_resumed', sessionId: 'session-1', resumed: 1 });

    expect(result.current.interrupted).toBe(false);
  });

  it('resets the flag when the viewed session changes', () => {
    const { result, rerender } = renderHook(({ sessionId }) => useInterruptedResume(sessionId), {
      initialProps: { sessionId: 'session-1' as string | null },
    });
    deliver({ kind: 'chat_subscribed', sessionId: 'session-1', interrupted: true, isProcessing: false });
    expect(result.current.interrupted).toBe(true);

    rerender({ sessionId: 'session-2' });

    expect(result.current.interrupted).toBe(false);
  });

  it('resume sends a chat.resume message and optimistically clears the flag', () => {
    const { result } = renderHook(() => useInterruptedResume('session-1'));
    deliver({ kind: 'chat_subscribed', sessionId: 'session-1', interrupted: true, isProcessing: false });
    expect(result.current.interrupted).toBe(true);

    act(() => result.current.resume());

    expect(mockSendMessage).toHaveBeenCalledWith({ type: 'chat.resume', sessionId: 'session-1' });
    expect(result.current.interrupted).toBe(false);
  });

  it('resume is a no-op without a session', () => {
    const { result } = renderHook(() => useInterruptedResume(null));

    act(() => result.current.resume());

    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
