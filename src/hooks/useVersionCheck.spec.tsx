import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fixed embedded SHA lets tests drive "matches the server" / "differs from the server"
// deterministically without depending on the real Vite `define` (absent under vitest) or
// package.json's actual version string.
vi.mock('../constants/build', () => ({ BUILD_SHA: 'embedded-sha' }));

const { VersionCheckProvider, useVersionCheck } = await import('./useVersionCheck');

/**
 * cloudcli#458: `useVersionCheck` is the actual detection logic for a stale tab — the pure
 * comparison lives in `buildVersion.ts` and is unit-tested there, but the hook's real
 * fetch/interval/visibilitychange wiring had NO test before this (0% branch coverage past
 * the initial `fetch` call, per the PR's own test-dimension review). That gap is exactly
 * what let a real race ship in the first revision of this PR: `NewVersionBanner`'s resume
 * handler read a prop that could not yet reflect a build landing while the tab was
 * backgrounded, and nothing exercised the wiring closely enough to catch it. These pin the
 * wiring directly, including `checkNow()` — the authoritative resume-time check.
 *
 * Follow-up to #458: the poll itself now lives in `VersionCheckProvider`, so every render
 * here happens inside one. The provider owning the interval/listener is what guarantees a
 * single live poll no matter how many components call `useVersionCheck` (the last describe
 * block below).
 */

const respondWith = (body: Record<string, unknown>) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const wrapper = ({ children }: { children: ReactNode }) => (
  <VersionCheckProvider>{children}</VersionCheckProvider>
);

const renderVersionCheckHook = () => renderHook(() => useVersionCheck(), { wrapper });

/** One of N simultaneous consumers of the shared version-check state. */
function VersionProbe({ label }: { label: string }) {
  const { newBuildAvailable } = useVersionCheck();
  return <span data-testid={label}>{newBuildAvailable ? 'new' : 'current'}</span>;
}

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
    renderVersionCheckHook();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith('/health');
  });

  it('flags newBuildAvailable on a SHA mismatch', async () => {
    vi.mocked(fetch).mockResolvedValue(
      respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'server-sha', built_at: 't' } }),
    );
    const { result } = renderVersionCheckHook();

    await waitFor(() => expect(result.current.newBuildAvailable).toBe(true));
  });

  it('does not flag a new build when the embedded and server SHAs match', async () => {
    vi.mocked(fetch).mockResolvedValue(
      respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'embedded-sha', built_at: 't' } }),
    );
    const { result } = renderVersionCheckHook();

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.newBuildAvailable).toBe(false);
  });

  it('re-polls /health on the 60s interval', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(respondWith({ installMode: 'git', version: '1.36.3' }));
    renderVersionCheckHook();

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
    renderVersionCheckHook();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    act(() => setVisibility('hidden'));
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it('clears its interval and visibilitychange listener on unmount', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(respondWith({ installMode: 'git', version: '1.36.3' }));
    const { unmount } = renderVersionCheckHook();

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
    const { result } = renderVersionCheckHook();

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(result.current.newBuildAvailable).toBe(false);
    consoleError.mockRestore();
  });

  describe('checkNow() — the resume-time authoritative check', () => {
    it('resolves directly with the fresh answer, not just via a later re-render', async () => {
      vi.mocked(fetch).mockResolvedValue(
        respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'server-sha', built_at: 't' } }),
      );
      const { result } = renderVersionCheckHook();
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
      const { result } = renderVersionCheckHook();
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
      const { result } = renderVersionCheckHook();
      await waitFor(() => expect(result.current.newBuildAvailable).toBe(true));

      vi.mocked(fetch).mockResolvedValue(
        respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'embedded-sha', built_at: 't' } }),
      );
      await act(async () => {
        await result.current.checkNow();
      });

      expect(result.current.newBuildAvailable).toBe(true);
    });

    it('deduplicates concurrent in-flight requests into a single /health fetch', async () => {
      let resolveFetch!: (res: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      vi.mocked(fetch).mockResolvedValueOnce(respondWith({ installMode: 'git', version: '1.36.3' }));
      const { result } = renderVersionCheckHook();
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

      vi.mocked(fetch).mockImplementation(() => fetchPromise);

      let p1!: Promise<boolean>;
      let p2!: Promise<boolean>;
      act(() => {
        p1 = result.current.checkNow();
        p2 = result.current.checkNow();
      });

      expect(fetch).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveFetch(
          respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'server-sha', built_at: 't' } }),
        );
      });

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1).toBe(true);
      expect(res2).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe('VersionCheckProvider — exactly one poll for many consumers (follow-up to #458)', () => {
  it('shares a single /health request among every mounted consumer, and they all see the update', async () => {
    vi.mocked(fetch).mockResolvedValue(
      respondWith({ installMode: 'git', version: '1.36.3', build: { sha: 'server-sha', built_at: 't' } }),
    );

    render(
      <VersionCheckProvider>
        <VersionProbe label="probe-a" />
        <VersionProbe label="probe-b" />
        <VersionProbe label="probe-c" />
      </VersionCheckProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('probe-a')).toHaveTextContent('new');
      expect(screen.getByTestId('probe-b')).toHaveTextContent('new');
      expect(screen.getByTestId('probe-c')).toHaveTextContent('new');
    });

    // Three consumers, still one poll — the regression this context removes.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('registers exactly one visibilitychange listener for many consumers', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    vi.mocked(fetch).mockResolvedValue(respondWith({ installMode: 'git', version: '1.36.3' }));

    render(
      <VersionCheckProvider>
        <VersionProbe label="probe-a" />
        <VersionProbe label="probe-b" />
      </VersionCheckProvider>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    const visibilityListeners = addSpy.mock.calls.filter(([type]) => type === 'visibilitychange');
    expect(visibilityListeners).toHaveLength(1);
    addSpy.mockRestore();
  });

  it('re-polls only once when several consumers are mounted and the tab resumes', async () => {
    vi.mocked(fetch).mockResolvedValue(respondWith({ installMode: 'git', version: '1.36.3' }));

    render(
      <VersionCheckProvider>
        <VersionProbe label="probe-a" />
        <VersionProbe label="probe-b" />
      </VersionCheckProvider>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
