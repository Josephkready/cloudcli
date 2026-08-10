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

  it('an unguarded processing mark clears the stamp, so later acks are honoured', () => {
    // The safety property the guard depends on: a genuinely new run always
    // arrives via an UNGUARDED mark (the send path and streaming events). That
    // must reset the idle stamp, or the new run's own subscribe ack would be
    // judged stale against the PREVIOUS run's completion and be dropped —
    // turning this fix into the very bug it replaces.
    const { result } = renderHook(() => useSessionProtection());

    // Run 1 completes at t=2000, leaving an idle stamp behind.
    vi.setSystemTime(1_000);
    act(() => result.current.markSessionProcessing(SESSION, { statusText: 'Run 1' }));
    vi.setSystemTime(2_000);
    act(() => result.current.markSessionIdle(SESSION));

    // Run 2 starts via an UNGUARDED mark, which must clear that stamp.
    vi.setSystemTime(3_000);
    act(() => result.current.markSessionProcessing(SESSION, { statusText: 'Run 2 start' }));

    // Run 2's own subscribe ack, sent at t=1500 — i.e. BEFORE run 1's idle.
    // Judged against run 1's stale stamp it would be dropped; judged correctly
    // (stamp cleared by run 2's start) it applies.
    vi.setSystemTime(5_000);
    act(() =>
      result.current.markSessionProcessing(
        SESSION,
        { statusText: 'Run 2 ack' },
        { ifNotIdledSince: 1_500 },
      ),
    );

    // Asserting on statusText, not merely `has()`: the entry already exists
    // from run 2's start, so presence alone cannot tell a dropped ack from an
    // applied one.
    expect(result.current.processingSessions.get(SESSION)?.statusText).toBe('Run 2 ack');
  });

  it('stamps an idle for a session that was already absent from the map', () => {
    // A terminal `complete` can beat the subscribe ack it ought to invalidate,
    // leaving nothing in the map to clear. Without stamping that no-op idle,
    // the late ack would look fresh and strand the flag.
    const { result } = renderHook(() => useSessionProtection());

    vi.setSystemTime(3_000);
    act(() => result.current.markSessionIdle(SESSION));

    vi.setSystemTime(4_000);
    act(() =>
      result.current.markSessionProcessing(SESSION, undefined, { ifNotIdledSince: 2_000 }),
    );

    expect(result.current.processingSessions.has(SESSION)).toBe(false);
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
