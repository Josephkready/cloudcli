import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionProtection } from './useSessionProtection';

/*
 * Regression lock for #318 — "press send and nothing happens".
 *
 * `chat_subscribed` acks are answered asymmetrically: the idle branch has
 * always been guarded against describing a state older than the subscribe that
 * asked for it (`ifStartedBefore`), but the processing branch was not. A late
 * ack saying `isProcessing: true` for a run that had already completed would
 * therefore re-mark the session as processing forever.
 *
 * That flag is what `isLoading` is derived from, and `handleSubmit` QUEUES
 * instead of sending while it is set — so a stuck flag presents to the user as
 * a composer that silently eats every message. Nothing expired it, and the
 * re-subscribe fires on every pass of the session-load effect (including the
 * "already loaded and fresh" early return, which a load-more triggers), so it
 * kept re-sticking until a full page reload.
 */

const SESSION = 'sess-318';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSessionProtection — stale chat_subscribed processing acks (#318)', () => {
  it('ignores a processing ack describing a run that already completed', () => {
    const { result } = renderHook(() => useSessionProtection());

    // A run is live, then completes (the `complete` event clears it).
    vi.setSystemTime(1_000);
    act(() => result.current.markSessionProcessing(SESSION));
    expect(result.current.processingSessions.has(SESSION)).toBe(true);

    // The client re-subscribes (e.g. a load-more re-runs the session effect).
    const subscribeSentAt = 2_000;
    vi.setSystemTime(subscribeSentAt);

    // The run completes AFTER that subscribe went out.
    vi.setSystemTime(3_000);
    act(() => result.current.markSessionIdle(SESSION));
    expect(result.current.processingSessions.has(SESSION)).toBe(false);

    // The ack for the earlier subscribe finally lands, still describing the
    // pre-completion state. It must NOT resurrect the session.
    vi.setSystemTime(4_000);
    act(() =>
      result.current.markSessionProcessing(SESSION, undefined, {
        ifNotIdledSince: subscribeSentAt,
      }),
    );

    expect(result.current.processingSessions.has(SESSION)).toBe(false);
  });

  it('still marks processing for an ack with no completion in between', () => {
    const { result } = renderHook(() => useSessionProtection());

    const subscribeSentAt = 2_000;
    vi.setSystemTime(3_000);
    act(() =>
      result.current.markSessionProcessing(SESSION, undefined, {
        ifNotIdledSince: subscribeSentAt,
      }),
    );

    // No idle happened after the subscribe, so this ack is authoritative.
    expect(result.current.processingSessions.has(SESSION)).toBe(true);
  });

  it('marks processing when the session idled BEFORE the subscribe went out', () => {
    const { result } = renderHook(() => useSessionProtection());

    // An older run completed at t=1000...
    vi.setSystemTime(1_000);
    act(() => result.current.markSessionProcessing(SESSION));
    act(() => result.current.markSessionIdle(SESSION));

    // ...then we subscribed at t=2000 and the ack reports a genuinely new run.
    vi.setSystemTime(3_000);
    act(() =>
      result.current.markSessionProcessing(SESSION, undefined, {
        ifNotIdledSince: 2_000,
      }),
    );

    expect(result.current.processingSessions.has(SESSION)).toBe(true);
  });

  it('an unguarded processing mark is unaffected (live streaming events)', () => {
    const { result } = renderHook(() => useSessionProtection());

    vi.setSystemTime(1_000);
    act(() => result.current.markSessionProcessing(SESSION));
    act(() => result.current.markSessionIdle(SESSION));

    // Streaming events mark processing without a guard; they must still work.
    vi.setSystemTime(2_000);
    act(() => result.current.markSessionProcessing(SESSION, { statusText: 'Working' }));

    expect(result.current.processingSessions.get(SESSION)?.statusText).toBe('Working');
  });
});
