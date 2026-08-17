import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionProtection } from './useSessionProtection';

/*
 * #349 — "this conversation status is running but it is done".
 *
 * `syncProcessingSessions` applies the server's running-sessions snapshot, and
 * keeps an entry the snapshot no longer reports while it is younger than the
 * local grace:
 *
 *     now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS
 *
 * That grace exists so a run this client just started is not dropped in the
 * window before the server reports it. But the arithmetic never expires when
 * `startedAt` sits in the FUTURE relative to the client clock: `now - startedAt`
 * is negative, negative is always under the grace, and the entry is re-retained
 * on every single sync — pinning the row to Running indefinitely.
 *
 * A future `startedAt` is not exotic. The field is documented as the client
 * clock, but `useRunningSessionsPoll` fills it from whatever the SERVER sent, so
 * any disagreement between a phone and dante lands here.
 */

const SESSION = 'sess-349';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSessionProtection — retention of entries the server no longer reports (#349)', () => {
  it('drops an entry whose start is far in the future instead of retaining it forever', () => {
    const { result } = renderHook(() => useSessionProtection());

    vi.setSystemTime(1_000_000);
    // The server reports a run whose startedAt is minutes ahead of this client.
    act(() => result.current.syncProcessingSessions([
      { sessionId: SESSION, startedAt: 1_000_000 + 5 * 60_000 },
    ]));
    expect(result.current.processingSessions.has(SESSION)).toBe(true);

    // The run finishes: the server stops reporting it. The entry must go.
    act(() => result.current.syncProcessingSessions([]));
    expect(result.current.processingSessions.has(SESSION)).toBe(false);
  });

  it('still tolerates a small clock disagreement, so a just-started run is not dropped', () => {
    const { result } = renderHook(() => useSessionProtection());

    vi.setSystemTime(1_000_000);
    // A couple of seconds of skew is ordinary and must keep its grace.
    act(() => result.current.syncProcessingSessions([
      { sessionId: SESSION, startedAt: 1_000_000 + 2_000 },
    ]));
    act(() => result.current.syncProcessingSessions([]));

    expect(result.current.processingSessions.has(SESSION)).toBe(true);
  });

  it('still retains a genuinely just-started local run through the grace window', () => {
    const { result } = renderHook(() => useSessionProtection());

    vi.setSystemTime(1_000_000);
    act(() => result.current.markSessionProcessing(SESSION));

    // The server has not caught up yet — this is exactly what the grace is for.
    act(() => result.current.syncProcessingSessions([]));
    expect(result.current.processingSessions.has(SESSION)).toBe(true);
  });

  it('still expires that run once the grace has elapsed', () => {
    const { result } = renderHook(() => useSessionProtection());

    vi.setSystemTime(1_000_000);
    act(() => result.current.markSessionProcessing(SESSION));

    vi.setSystemTime(1_000_000 + 11_000);
    act(() => result.current.syncProcessingSessions([]));
    expect(result.current.processingSessions.has(SESSION)).toBe(false);
  });
});
