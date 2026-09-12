import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fixed embedded SHA lets tests drive "matches the server" / "differs from the server"
// deterministically without depending on the real Vite `define` (absent under vitest) or
// package.json's actual version string.
vi.mock('../constants/build', () => ({ BUILD_SHA: 'embedded-sha' }));

const { useVersionCheck } = await import('./useVersionCheck');

/**
 * cloudcli#458: `useVersionCheck` is the actual detection logic for a stale tab — the pure
 * comparison lives in `buildVersion.ts` and is unit-tested there, but the hook's real
 * fetch/interval/visibilitychange wiring had NO test before this (0% branch coverage past
 * the initial `fetch` call, per the PR's own test-dimension review). That gap is exactly
 * what let a real race ship in the first revision of this PR: `NewVersionBanner`'s resume
 * handler read a prop that could not yet reflect a build landing while the tab was
 * backgrounded, and nothing exercised the wiring closely enough to catch it. These pin the
 * wiring directly, including `checkNow()` — the authoritative resume-time check.
 */

const respondWith = (body: Record<string, unknown>) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

function setVisibility(state: DocumentVisibilityState, { notify = true } = {}) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  if (notify) {
    document.dispatchEvent(new Event('visibilitychange'));
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  setVisibility('visible', { notify: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility('visible', { notify: false });
});

describe('useVersionCheck — polling and resume wiring (#458)', () => {
  it('fetches /health once on mount', async () => {
    vi.mocked(fetch).mockResolvedValue(respondWith({ installMode: 'git', version: '1.36.3' }));
    renderHook(() => useVersionCheck());

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith('/health');
  });

  it('flags newBuildAvailable on a SHA mismatch', async () => {
    vi.mocked(fetch).mockResolvedValue(
      respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'server-sha', built_at: 't' } }),
    );
    const { result } = renderHook(() => useVersionCheck());

    await waitFor(() => expect(result.current.newBuildAvailable).toBe(true));
  });

  it('does not flag a new build when the embedded and server SHAs match', async () => {
    vi.mocked(fetch).mockResolvedValue(
      respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'embedded-sha', built_at: 't' } }),
    );
    const { result } = renderHook(() => useVersionCheck());

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.newBuildAvailable).toBe(false);
  });

  it('re-polls /health on the 60s interval', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(respondWith({ installMode: 'git', version: '1.36.3' }));
    renderHook(() => useVersionCheck());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('re-polls /health when the tab becomes visible again', async () => {
    vi.mocked(fetch).mockResolvedValue(respondWith({ installMode: 'git', version: '1.36.3' }));
    renderHook(() => useVersionCheck());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    act(() => setVisibility('hidden'));
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it('clears its interval and visibilitychange listener on unmount', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(respondWith({ installMode: 'git', version: '1.36.3' }));
    const { unmount } = renderHook(() => useVersionCheck());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const before = vi.mocked(fetch).mock.calls.length;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000 * 5);
    });
    expect(fetch).toHaveBeenCalledTimes(before);

    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    expect(fetch).toHaveBeenCalledTimes(before);
  });

  it('logs and leaves state unchanged when /health fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useVersionCheck());

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(result.current.newBuildAvailable).toBe(false);
    consoleError.mockRestore();
  });

  describe('checkNow() — the resume-time authoritative check', () => {
    it('resolves directly with the fresh answer, not just via a later re-render', async () => {
      vi.mocked(fetch).mockResolvedValue(
        respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'server-sha', built_at: 't' } }),
      );
      const { result } = renderHook(() => useVersionCheck());
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

      let resolved: boolean | undefined;
      await act(async () => {
        resolved = await result.current.checkNow();
      });

      expect(resolved).toBe(true);
      expect(result.current.newBuildAvailable).toBe(true);
    });

    it('is what actually detects a build that lands while the tab is backgrounded — the mount fetch alone cannot see it', async () => {
      // This is the exact scenario the #458 PR review's race finding was about: a build
      // deployed after the mount fetch but before the tab resumes must still be caught by
      // the resume-time call, since nothing else will have re-checked in between.
      vi.mocked(fetch).mockResolvedValueOnce(respondWith({ installMode: 'git', version: '1.36.3' }));
      const { result } = renderHook(() => useVersionCheck());
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(result.current.newBuildAvailable).toBe(false);

      // A deploy lands while the tab is backgrounded.
      vi.mocked(fetch).mockResolvedValue(
        respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'server-sha', built_at: 't' } }),
      );

      let resolved: boolean | undefined;
      await act(async () => {
        resolved = await result.current.checkNow();
      });

      expect(resolved).toBe(true);
      expect(result.current.newBuildAvailable).toBe(true);
    });

    it('never un-latches once a new build has been detected, even if a later check sees a matching SHA again', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'server-sha', built_at: 't' } }),
      );
      const { result } = renderHook(() => useVersionCheck());
      await waitFor(() => expect(result.current.newBuildAvailable).toBe(true));

      vi.mocked(fetch).mockResolvedValue(
        respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'embedded-sha', built_at: 't' } }),
      );
      await act(async () => {
        await result.current.checkNow();
      });

      expect(result.current.newBuildAvailable).toBe(true);
    });
  });
});
