import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWarmLazySurfaces } from './useWarmLazySurfaces';

/*
 * The warm-up exists to buy back the first-click cost that code splitting
 * introduces (issue #267) — but it spends bandwidth and idle CPU on behalf of a
 * user who may never open the surface, so *when* it runs is the whole design.
 * These cases pin the three things that would quietly break it: running before
 * the page has loaded, running on a metered connection, and running outside an
 * idle callback.
 */

type IdleCallback = (deadline: IdleDeadline) => void;

describe('useWarmLazySurfaces', () => {
  let idleTasks: IdleCallback[];

  beforeEach(() => {
    idleTasks = [];
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((task: IdleCallback) => {
        idleTasks.push(task);
        return idleTasks.length;
      }),
    );
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'connection');
  });

  const flushIdle = () => {
    const tasks = idleTasks.splice(0, idleTasks.length);
    tasks.forEach((task) => task({ didTimeout: false, timeRemaining: () => 50 }));
  };

  it('loads each surface in its own idle callback', async () => {
    const shell = vi.fn().mockResolvedValue({});
    const editor = vi.fn().mockResolvedValue({});

    renderHook(() => useWarmLazySurfaces([shell, editor]));

    // Nothing runs synchronously — that would be the very main-thread work the
    // split was meant to remove.
    expect(shell).not.toHaveBeenCalled();
    expect(idleTasks).toHaveLength(2);

    flushIdle();
    expect(shell).toHaveBeenCalledTimes(1);
    expect(editor).toHaveBeenCalledTimes(1);
  });

  it('waits for the load event when the page is still loading', () => {
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    const shell = vi.fn().mockResolvedValue({});

    renderHook(() => useWarmLazySurfaces([shell]));

    expect(idleTasks).toHaveLength(0);

    window.dispatchEvent(new Event('load'));
    expect(idleTasks).toHaveLength(1);

    flushIdle();
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it('skips the warm-up entirely when the user asked to save data', () => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
    const shell = vi.fn().mockResolvedValue({});

    renderHook(() => useWarmLazySurfaces([shell]));

    expect(idleTasks).toHaveLength(0);
    expect(shell).not.toHaveBeenCalled();
  });

  it('does not warm after unmount', () => {
    const shell = vi.fn().mockResolvedValue({});

    const { unmount } = renderHook(() => useWarmLazySurfaces([shell]));
    unmount();
    flushIdle();

    expect(shell).not.toHaveBeenCalled();
  });

  it('swallows a failed warm-up — the surface still loads on demand', async () => {
    const shell = vi.fn().mockRejectedValue(new Error('offline'));

    renderHook(() => useWarmLazySurfaces([shell]));
    flushIdle();

    await Promise.resolve();
    expect(shell).toHaveBeenCalledTimes(1);
  });
});
