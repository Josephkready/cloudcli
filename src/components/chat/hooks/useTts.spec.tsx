import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTts } from './useTts';
import type { TtsState } from './useTts';

let snapshot: { state: TtsState; error: string | null } = { state: 'idle', error: null };
let listener: (() => void) | null = null;

const mockGetSnapshot = vi.fn((_id: string) => snapshot);
const mockSubscribe = vi.fn((fn: () => void) => {
  listener = fn;
  return () => {
    listener = null;
  };
});
const mockUnlock = vi.fn();
const mockToggle = vi.fn();

vi.mock('../../../lib/voicePlayer', () => ({
  voiceId: (content: string) => `id:${content}`,
  voicePlayer: {
    getSnapshot: (id: string) => mockGetSnapshot(id),
    subscribe: (fn: () => void) => mockSubscribe(fn),
    unlock: () => mockUnlock(),
    toggle: (content: string) => mockToggle(content),
  },
}));

beforeEach(() => {
  snapshot = { state: 'idle', error: null };
  mockGetSnapshot.mockClear();
  mockSubscribe.mockClear();
  mockUnlock.mockClear();
  mockToggle.mockClear();
  listener = null;
});

describe('useTts', () => {
  it('reflects the player snapshot for this message id', () => {
    const { result } = renderHook(() => useTts(() => 'hello world'));
    expect(mockGetSnapshot).toHaveBeenCalledWith('id:hello world');
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBe(null);
  });

  it('updates when the player broadcasts a changed snapshot', () => {
    const { result } = renderHook(() => useTts(() => 'hello world'));

    snapshot = { state: 'playing', error: null };
    act(() => listener?.());

    expect(result.current.state).toBe('playing');
  });

  it('does not trigger a state update when the broadcast snapshot is unchanged', () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useTts(() => 'hello world');
    });
    const countAfterMount = renderCount;

    act(() => listener?.());

    expect(renderCount).toBe(countAfterMount);
    expect(result.current.state).toBe('idle');
  });

  it('toggle unlocks the player (for the iOS gesture) then toggles playback', () => {
    const { result } = renderHook(() => useTts(() => 'hello world'));

    act(() => result.current.toggle());

    expect(mockUnlock).toHaveBeenCalledTimes(1);
    expect(mockToggle).toHaveBeenCalledWith('hello world');
  });

  it('re-subscribes when the message content changes id', () => {
    const { rerender } = renderHook(({ text }: { text: string }) => useTts(() => text), {
      initialProps: { text: 'first' },
    });
    expect(mockGetSnapshot).toHaveBeenCalledWith('id:first');

    rerender({ text: 'second' });

    expect(mockGetSnapshot).toHaveBeenCalledWith('id:second');
  });
});
