import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

/*
 * useMinuteClock backs the sidebar perf audit's finding 4: SidebarSessionItem
 * and ConversationRow read "now" from this shared store directly instead of
 * via a `currentTime` prop threaded down from useSidebarController, so a
 * clock tick only re-renders the rows that display a relative-age label
 * instead of the whole project/session tree.
 *
 * These specs pin the module's three load-bearing guarantees that the
 * production wiring depends on but no other test exercises (every existing
 * row-component spec passes an explicit `currentTime` prop, which bypasses
 * this hook entirely):
 *  1. every subscriber advances together on one shared tick,
 *  2. exactly one `setInterval` backs any number of mounted subscribers, and
 *  3. that interval is torn down once the last subscriber unmounts (no leak).
 *
 * The module holds its clock as file-scope singleton state, so each test
 * re-imports it fresh via `vi.resetModules()` to avoid cross-test bleed.
 */

async function freshModule() {
  vi.resetModules();
  return import('./useMinuteClock');
}

describe('useMinuteClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances every subscriber together on one shared 60s tick', async () => {
    const { useMinuteClock } = await freshModule();

    const seenByA: number[] = [];
    const seenByB: number[] = [];

    function Reader({ sink }: { sink: number[] }) {
      const now = useMinuteClock();
      sink.push(now.getTime());
      return null;
    }

    render(
      <>
        <Reader sink={seenByA} />
        <Reader sink={seenByB} />
      </>,
    );

    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);
    // Both start on the same initial snapshot.
    expect(seenByA[0]).toBe(seenByB[0]);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(seenByA).toHaveLength(2);
    expect(seenByB).toHaveLength(2);
    // Both advanced to the same new instant, and it's actually later.
    expect(seenByA[1]).toBe(seenByB[1]);
    expect(seenByA[1]).toBeGreaterThan(seenByA[0]);
  });

  it('backs any number of subscribers with exactly one setInterval', async () => {
    const { useMinuteClock } = await freshModule();
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    function Reader() {
      useMinuteClock();
      return null;
    }

    render(
      <>
        <Reader />
        <Reader />
        <Reader />
      </>,
    );

    // Three mounted subscribers, but the ref-counted `subscribe` only calls
    // `setInterval` for the first one — the other two just join the same set.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('tears the interval down once the last subscriber unmounts', async () => {
    const { useMinuteClock } = await freshModule();
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    function Reader() {
      useMinuteClock();
      return null;
    }

    const first = render(<Reader />);
    const second = render(<Reader />);

    first.unmount();
    // One subscriber remains — the interval must survive.
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    second.unmount();
    // No subscribers left — the interval must be cleared, not leaked.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('does not tick before 60s and does not double-tick within one interval', async () => {
    const { useMinuteClock } = await freshModule();
    const seen: number[] = [];

    function Reader() {
      const now = useMinuteClock();
      seen.push(now.getTime());
      return null;
    }

    render(<Reader />);
    expect(seen).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(seen).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(seen).toHaveLength(2);
  });
});
