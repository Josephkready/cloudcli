import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchConversationsUrl = vi.fn((query: string) => `/search?q=${query}`);
const streamAuthenticatedSse = vi.fn();

vi.mock('../../../utils/api', () => ({
  api: { searchConversationsUrl },
}));

vi.mock('../../../utils/sse', () => ({
  streamAuthenticatedSse: (...args: unknown[]) => streamAuthenticatedSse(...args),
}));

const { useSessionMessageSearch } = await import('./useSessionMessageSearch');

type SseCallback = (event: { event: string; data: string }) => void;

beforeEach(() => {
  vi.useFakeTimers();
  searchConversationsUrl.mockClear();
  streamAuthenticatedSse.mockReset();
  streamAuthenticatedSse.mockImplementation(() => new Promise<void>(() => {}));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSessionMessageSearch SSE lifecycle', () => {
  it('aborts the old stream and ignores its stale events when the query changes', async () => {
    const callbacks: SseCallback[] = [];
    const signals: AbortSignal[] = [];
    streamAuthenticatedSse.mockImplementation((_url, callback, options) => {
      callbacks.push(callback as SseCallback);
      signals.push((options as RequestInit).signal as AbortSignal);
      return new Promise<void>(() => {});
    });

    const view = renderHook(({ query }) => useSessionMessageSearch('project-1', query, true), {
      initialProps: { query: 'first' },
    });
    await act(async () => vi.advanceTimersByTime(250));

    expect(signals[0]?.aborted).toBe(false);
    view.rerender({ query: 'second' });
    expect(signals[0]?.aborted).toBe(true);

    act(() => callbacks[0]?.({
      event: 'result',
      data: JSON.stringify({
        projectResult: {
          projectId: 'project-1',
          sessions: [{
            sessionId: 'stale-session',
            sessionSummary: 'stale',
            provider: 'claude',
            matches: [{ snippet: 'must not render' }],
          }],
        },
      }),
    }));

    expect(view.result.current).toEqual([]);
  });

  it('collects matching results, tolerates malformed data, and aborts on done', async () => {
    let callback: SseCallback | undefined;
    let signal: AbortSignal | undefined;
    streamAuthenticatedSse.mockImplementation((_url, onEvent, options) => {
      callback = onEvent as SseCallback;
      signal = (options as RequestInit).signal as AbortSignal;
      return new Promise<void>(() => {});
    });

    const view = renderHook(() => useSessionMessageSearch('project-1', 'hello', true));
    await act(async () => vi.advanceTimersByTime(250));

    expect(() => callback?.({ event: 'result', data: '{bad json' })).not.toThrow();
    act(() => callback?.({
      event: 'result',
      data: JSON.stringify({
        projectResult: {
          projectId: 'project-1',
          sessions: [{
            sessionId: 'session-1',
            sessionSummary: 'Summary',
            provider: 'codex',
            matches: [{ snippet: 'hello world' }],
          }],
        },
      }),
    }));

    expect(view.result.current).toEqual([{
      sessionId: 'session-1',
      label: 'Summary',
      snippet: 'hello world',
      provider: 'codex',
    }]);

    act(() => callback?.({ event: 'done', data: '{}' }));
    expect(signal?.aborted).toBe(true);
  });
});
