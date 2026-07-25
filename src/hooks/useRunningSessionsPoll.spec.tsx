import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runningSessions = vi.fn();

vi.mock('@/utils/api', () => ({
  api: { runningSessions: (...args: unknown[]) => runningSessions(...args) },
  authenticatedFetch: vi.fn(),
  isValidRefreshedToken: () => false,
}));

const {
  RUNNING_SESSIONS_ACTIVE_POLL_MS,
  RUNNING_SESSIONS_IDLE_POLL_MS,
  useRunningSessionsPoll,
} = await import('./useRunningSessionsPoll');

/*
 * #273: the running-sessions poll used to fire every 5s forever, checking
 * nothing — including in a backgrounded tab, which is what actually costs
 * battery on an iOS PWA. It now stops entirely while the tab is hidden, catches
 * up with a single fetch when it returns, and backs off to a slower cadence
 * while the websocket is healthy and no run is in flight.
 */

const respondWith = (sessions: unknown[]) => {
  runningSessions.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { sessions } }),
  } as unknown as Response);
};

function setVisibility(state: DocumentVisibilityState, { notify = true } = {}) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  if (notify) {
    document.dispatchEvent(new Event('visibilitychange'));
  }
}

function mountPoll({
  hasRunningSessions = false,
  isConnected = true,
  syncProcessingSessions = vi.fn(),
} = {}) {
  const rendered = renderHook(
    (props: { hasRunningSessions: boolean; isConnected: boolean }) =>
      useRunningSessionsPoll({ ...props, syncProcessingSessions }),
    { initialProps: { hasRunningSessions, isConnected } },
  );
  return { ...rendered, syncProcessingSessions };
}

beforeEach(() => {
  runningSessions.mockReset();
  respondWith([]);
  setVisibility('visible', { notify: false });
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible', { notify: false });
});

describe('useRunningSessionsPoll — visibility gating (#273)', () => {
  it('fetches once on mount', async () => {
    mountPoll();

    await waitFor(() => expect(runningSessions).toHaveBeenCalledTimes(1));
  });

  it('issues no polled requests while the tab is hidden', async () => {
    setVisibility('hidden', { notify: false });
    vi.useFakeTimers();
    mountPoll({ hasRunningSessions: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_IDLE_POLL_MS * 4);
    });

    // Only the mount fetch. The old unconditional interval would have fired
    // roughly 24 times over this window.
    expect(runningSessions).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the tab is backgrounded mid-flight', async () => {
    vi.useFakeTimers();
    mountPoll({ hasRunningSessions: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS);
    });
    const whileVisible = runningSessions.mock.calls.length;
    expect(whileVisible).toBeGreaterThan(1);

    act(() => {
      setVisibility('hidden');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS * 10);
    });

    expect(runningSessions).toHaveBeenCalledTimes(whileVisible);
  });

  it('catches up with one immediate fetch when the tab becomes visible again', async () => {
    setVisibility('hidden', { notify: false });
    vi.useFakeTimers();
    mountPoll({ hasRunningSessions: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS * 3);
    });
    expect(runningSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility('visible');
    });
    expect(runningSessions).toHaveBeenCalledTimes(2);

    // …and the interval is running again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS);
    });
    expect(runningSessions).toHaveBeenCalledTimes(3);
  });
});

describe('useRunningSessionsPoll — cadence back-off (#273)', () => {
  it('polls at the active cadence while a session is running', async () => {
    vi.useFakeTimers();
    mountPoll({ hasRunningSessions: true, isConnected: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS * 2);
    });

    expect(runningSessions).toHaveBeenCalledTimes(3);
  });

  it('backs off when the socket is healthy and nothing is running', async () => {
    vi.useFakeTimers();
    mountPoll({ hasRunningSessions: false, isConnected: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS * 2);
    });
    expect(runningSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_IDLE_POLL_MS);
    });
    expect(runningSessions).toHaveBeenCalledTimes(2);
  });

  it('keeps the active cadence while the websocket is down', async () => {
    // With no socket even `session_upserted` is missing, so the poll is the
    // only signal left and must not back off.
    vi.useFakeTimers();
    mountPoll({ hasRunningSessions: false, isConnected: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS);
    });

    expect(runningSessions).toHaveBeenCalledTimes(2);
  });

  it('switches to the active cadence as soon as a run starts', async () => {
    vi.useFakeTimers();
    const { rerender } = mountPoll({ hasRunningSessions: false, isConnected: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS);
    });
    expect(runningSessions).toHaveBeenCalledTimes(1);

    rerender({ hasRunningSessions: true, isConnected: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS);
    });

    expect(runningSessions).toHaveBeenCalledTimes(2);
  });

  it('clears its interval on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = mountPoll({ hasRunningSessions: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS);
    });
    const beforeUnmount = runningSessions.mock.calls.length;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_SESSIONS_ACTIVE_POLL_MS * 5);
    });

    expect(runningSessions).toHaveBeenCalledTimes(beforeUnmount);
  });
});

describe('useRunningSessionsPoll — payload handling', () => {
  it('normalizes the API payload into activity snapshots', async () => {
    respondWith([
      {
        sessionId: 's1',
        startedAt: '2026-07-20T00:00:00.000Z',
        statusText: 'Thinking',
        canInterrupt: true,
        blocked: false,
      },
      { sessionId: 's2', startedAt: 1_700_000_000_000 },
      { sessionId: '', startedAt: 5 },
      { startedAt: 5 },
    ]);
    const { syncProcessingSessions } = mountPoll();

    await waitFor(() => expect(syncProcessingSessions).toHaveBeenCalled());

    expect(syncProcessingSessions.mock.calls[0][0]).toEqual([
      {
        sessionId: 's1',
        startedAt: Date.parse('2026-07-20T00:00:00.000Z'),
        statusText: 'Thinking',
        canInterrupt: true,
        blocked: false,
      },
      {
        sessionId: 's2',
        startedAt: 1_700_000_000_000,
        statusText: undefined,
        canInterrupt: undefined,
        blocked: undefined,
      },
    ]);
  });

  it('drops an unparseable startedAt rather than inventing one', async () => {
    respondWith([{ sessionId: 's1', startedAt: 'not a date' }, { sessionId: 's2', startedAt: -1 }]);
    const { syncProcessingSessions } = mountPoll();

    await waitFor(() => expect(syncProcessingSessions).toHaveBeenCalled());

    const snapshots = syncProcessingSessions.mock.calls[0][0] as Array<{ startedAt?: number }>;
    expect(snapshots.map((snapshot) => snapshot.startedAt)).toEqual([undefined, undefined]);
  });

  it('leaves the activity map alone when the request fails', async () => {
    runningSessions.mockResolvedValue({ ok: false } as unknown as Response);
    const { syncProcessingSessions } = mountPoll();

    await waitFor(() => expect(runningSessions).toHaveBeenCalled());

    expect(syncProcessingSessions).not.toHaveBeenCalled();
  });

  it('survives a rejected request', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    runningSessions.mockRejectedValue(new Error('offline'));
    const { syncProcessingSessions } = mountPoll();

    await waitFor(() => expect(consoleError).toHaveBeenCalled());

    expect(syncProcessingSessions).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
