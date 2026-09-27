import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUILD_SHA } from '../constants/build';
import { version as PACKAGE_VERSION } from '../../package.json';
import { useVersionCheck, VersionCheckProvider } from './VersionCheckContext';

/*
 * VersionCheckContext owns the single shared `/health` poll (#458). Before this context
 * existed, `useVersionCheck` was called independently by four components, each starting
 * its own interval. This spec drives the provider directly against a mocked `fetch`
 * rather than any one consumer, since the polling/latching/dedupe behaviour lives here.
 *
 * Fake timers are used throughout (the interval is 60s — too slow to wait on for real),
 * so every assertion after a fetch resolves goes through `flush()` rather than
 * `waitFor`, which itself relies on real timers.
 */

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function Consumer() {
  const value = useVersionCheck();
  return (
    <div>
      <div data-testid="installMode">{value.installMode}</div>
      <div data-testid="runningVersion">{value.runningVersion ?? ''}</div>
      <div data-testid="restartRequired">{String(value.restartRequired)}</div>
      <div data-testid="newBuildAvailable">{String(value.newBuildAvailable)}</div>
      <div data-testid="buildSha">{value.build?.sha ?? ''}</div>
    </div>
  );
}

function jsonResponse(body: unknown) {
  return { json: () => Promise.resolve(body) } as Response;
}

describe('VersionCheckProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches /health on mount and publishes the running version / install mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ installMode: 'npm', version: PACKAGE_VERSION }))),
    );

    render(
      <VersionCheckProvider>
        <Consumer />
      </VersionCheckProvider>,
    );
    await flush();

    expect(screen.getByTestId('installMode').textContent).toBe('npm');
    expect(screen.getByTestId('runningVersion').textContent).toBe(PACKAGE_VERSION);
    expect(screen.getByTestId('restartRequired').textContent).toBe('false');
    expect(fetch).toHaveBeenCalledWith('/health');
  });

  it('flags restartRequired when the server reports a different package version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ installMode: 'git', version: '0.0.1-does-not-match' }))),
    );

    render(
      <VersionCheckProvider>
        <Consumer />
      </VersionCheckProvider>,
    );
    await flush();

    expect(screen.getByTestId('restartRequired').textContent).toBe('true');
  });

  // `BUILD_SHA` is baked in by Vite's `define` at build time (see src/constants/build.ts)
  // and is empty in this non-Vite test run, so `resolveNewBuildAvailable` falls back to
  // its semver comparison here — a server version that differs from the embedded one.
  it('detects a new build via the semver fallback when no embedded SHA is baked in', async () => {
    expect(BUILD_SHA).toBe('');
    const serverVersion = `${PACKAGE_VERSION}-server-ahead`;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            installMode: 'git',
            version: serverVersion,
            build: { sha: null, built_at: '2026-01-01T00:00:00Z' },
          }),
        ),
      ),
    );

    render(
      <VersionCheckProvider>
        <Consumer />
      </VersionCheckProvider>,
    );
    await flush();

    expect(screen.getByTestId('newBuildAvailable').textContent).toBe('true');
    expect(screen.getByTestId('buildSha').textContent).toBe('');
  });

  it('latches newBuildAvailable — a later fetch cannot un-flag it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          installMode: 'git',
          version: `${PACKAGE_VERSION}-server-ahead`,
          build: { sha: null, built_at: null },
        }),
      )
      .mockResolvedValue(jsonResponse({ installMode: 'git', version: PACKAGE_VERSION, build: null }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <VersionCheckProvider>
        <Consumer />
      </VersionCheckProvider>,
    );
    await flush();
    expect(screen.getByTestId('newBuildAvailable').textContent).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByTestId('newBuildAvailable').textContent).toBe('true');
  });

  it('ignores a fetch failure and keeps the previous latched answer', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));

    render(
      <VersionCheckProvider>
        <Consumer />
      </VersionCheckProvider>,
    );
    await flush();

    expect(errorSpy).toHaveBeenCalled();
    expect(screen.getByTestId('newBuildAvailable').textContent).toBe('false');
  });

  it('re-checks on a visibilitychange to visible', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ installMode: 'git', version: PACKAGE_VERSION })),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <VersionCheckProvider>
        <Consumer />
      </VersionCheckProvider>,
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('polls /health on the background interval', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ installMode: 'git', version: PACKAGE_VERSION })),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <VersionCheckProvider>
        <Consumer />
      </VersionCheckProvider>,
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent checkNow calls into a single in-flight request', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    let capturedCheckNow: (() => Promise<boolean>) | null = null;
    function Capture() {
      const value = useVersionCheck();
      capturedCheckNow = value.checkNow;
      return null;
    }

    render(
      <VersionCheckProvider>
        <Capture />
      </VersionCheckProvider>,
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let secondResult: boolean | undefined;
    await act(async () => {
      const second = capturedCheckNow!();
      resolveFetch(jsonResponse({ installMode: 'git', version: PACKAGE_VERSION }));
      secondResult = await second;
    });

    // Only the initial mount fetch happened — the concurrent call reused it rather than
    // issuing a second /health request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secondResult).toBe(false);
  });

  it('throws when useVersionCheck is used outside the provider', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(
      'useVersionCheck must be used within a VersionCheckProvider',
    );
    errorSpy.mockRestore();
  });
});
