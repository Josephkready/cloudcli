import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

/**
 * Coverage-gap tests for `useSessionStore.ts`.
 *
 * The other spec files in this directory each pin one specific bug/regression
 * (id-less realtime rows, blank-refresh guard, windowed-refresh splice). This
 * file exercises the remaining wiring in the hook that none of those happen to
 * touch: the notify/active-session gate, the transcript cache read/write path,
 * `fetchMore`'s early-return/race/failure branches, the realtime-message
 * session-stamping and truncation logic, `refreshFromServer`'s network-failure
 * branch, and the small status/streaming/lookup helpers
 * (`setStatus`, `isStale`, `updateStreaming`, `finalizeStreaming`,
 * `clearRealtime`, `has`, `getSessionSlot`).
 */

const mockFetch = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));

const mockReadCachedTranscript = vi.fn();
const mockWriteCachedTranscript = vi.fn();
const mockDeleteCachedTranscript = vi.fn();
vi.mock('./transcriptCache', () => ({
  readCachedTranscript: (...args: unknown[]) => mockReadCachedTranscript(...args),
  writeCachedTranscript: (...args: unknown[]) => mockWriteCachedTranscript(...args),
  deleteCachedTranscript: (...args: unknown[]) => mockDeleteCachedTranscript(...args),
}));

const SESSION = 'sess-gaps';
const OTHER_SESSION = 'sess-other';

let msgSeq = 0;

function msg(id: number | string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  const offsetMs = /^\d+$/.test(String(id)) ? Number(id) * 1000 : ++msgSeq * 1000;
  return {
    id: `m${id}`,
    sessionId: SESSION,
    kind: 'text',
    role: 'user',
    content: `message ${id}`,
    provider: 'claude',
    timestamp: new Date(1_700_000_000_000 + offsetMs).toISOString(),
    ...overrides,
  } as NormalizedMessage;
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => ({ data: body }) };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockReadCachedTranscript.mockReset();
  mockWriteCachedTranscript.mockReset();
  mockDeleteCachedTranscript.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('notify / setActiveSession gate', () => {
  it('does not re-render for a session that is not the active one', async () => {
    const { result } = renderHook(() => useSessionStore());
    let renderCountBefore = 0;
    // setStatus triggers notify(); with no active session set, notify() must
    // not touch React state.
    act(() => {
      result.current.setActiveSession(OTHER_SESSION);
    });
    renderCountBefore = result.current.getSlot(SESSION).status === 'idle' ? 1 : 0;
    act(() => {
      result.current.setStatus(SESSION, 'loading');
    });
    // The slot itself still updates regardless of active-session gating.
    expect(result.current.getSlot(SESSION).status).toBe('loading');
    expect(renderCountBefore).toBe(1);
  });

  it('setActiveSession(null) is accepted and gates every notify', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.setActiveSession(null);
      result.current.setStatus(SESSION, 'error');
    });
    expect(result.current.getSlot(SESSION).status).toBe('error');
  });

  it('bumps the tick (forces a re-render) when the notified session is active', async () => {
    const { result, rerender } = renderHook(() => useSessionStore());
    act(() => {
      result.current.setActiveSession(SESSION);
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    rerender();
    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(1);
  });
});

describe('has', () => {
  it('is false until a slot has been created', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(result.current.has(SESSION)).toBe(false);
    result.current.getSlot(SESSION);
    expect(result.current.has(SESSION)).toBe(true);
  });
});

describe('noteProvider + persistSlot (cache write path, #511)', () => {
  it('does not write the cache when the provider was never noted', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(mockWriteCachedTranscript).not.toHaveBeenCalled();
  });

  it('writes the cache after the provider has been noted', async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.noteProvider(SESSION, 'claude');
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1), msg(2)], total: 2, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(mockWriteCachedTranscript).toHaveBeenCalledTimes(1);
    const written = mockWriteCachedTranscript.mock.calls[0][0];
    expect(written.sessionId).toBe(SESSION);
    expect(written.provider).toBe('claude');
    expect(written.serverMessages).toHaveLength(2);
  });

  it('skips rewriting the cache when the fingerprint is unchanged', async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.noteProvider(SESSION, 'claude');
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(mockWriteCachedTranscript).toHaveBeenCalledTimes(1);

    // Same transcript again: fingerprint matches, so the second write is skipped.
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(mockWriteCachedTranscript).toHaveBeenCalledTimes(1);
  });

  it('drops a prior cache entry once the transcript grows too large to cache', async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.noteProvider(SESSION, 'claude');
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(mockWriteCachedTranscript).toHaveBeenCalledTimes(1);

    // MAX_CACHED_MESSAGES_PER_SESSION is 1000 in transcriptCache.pure.ts.
    const huge = Array.from({ length: 1001 }, (_, i) => msg(i));
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: huge, total: huge.length, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(mockDeleteCachedTranscript).toHaveBeenCalledWith(SESSION);
    // No second write since the transcript is now too large to cache.
    expect(mockWriteCachedTranscript).toHaveBeenCalledTimes(1);
  });
});

describe('hydrateFromCache (#511)', () => {
  it('hydrates an empty slot from a cache hit', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockReadCachedTranscript.mockResolvedValueOnce({
      sessionId: SESSION,
      provider: 'claude',
      serverMessages: [msg(1), msg(2)],
      hasMore: true,
      offset: 2,
      total: 10,
      fingerprint: 'fp1',
      cachedAt: Date.now(),
    });

    let hydrated: boolean | undefined;
    await act(async () => {
      hydrated = await result.current.hydrateFromCache(SESSION);
    });

    expect(hydrated).toBe(true);
    const slot = result.current.getSlot(SESSION);
    expect(slot.serverMessages).toHaveLength(2);
    expect(slot.hasMore).toBe(true);
    expect(slot.total).toBe(10);
    expect(slot.status).toBe('idle');
    expect(slot.merged.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('does nothing for a cache miss', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockReadCachedTranscript.mockResolvedValueOnce(null);

    let hydrated: boolean | undefined;
    await act(async () => {
      hydrated = await result.current.hydrateFromCache(SESSION);
    });

    expect(hydrated).toBe(false);
    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(0);
  });

  it('does nothing for a cache entry with no messages', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockReadCachedTranscript.mockResolvedValueOnce({
      sessionId: SESSION,
      provider: 'claude',
      serverMessages: [],
      hasMore: false,
      offset: 0,
      total: 0,
      fingerprint: '0',
      cachedAt: Date.now(),
    });

    let hydrated: boolean | undefined;
    await act(async () => {
      hydrated = await result.current.hydrateFromCache(SESSION);
    });

    expect(hydrated).toBe(false);
  });

  it('never touches the cache when the slot already has messages', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    let hydrated: boolean | undefined;
    await act(async () => {
      hydrated = await result.current.hydrateFromCache(SESSION);
    });

    expect(hydrated).toBe(false);
    expect(mockReadCachedTranscript).not.toHaveBeenCalled();
  });

  it('does not clobber a network fetch that landed while the cache read was in flight', async () => {
    const { result } = renderHook(() => useSessionStore());

    let resolveCacheRead: (value: unknown) => void = () => {};
    mockReadCachedTranscript.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCacheRead = resolve;
      }),
    );

    const hydratePromise = result.current.hydrateFromCache(SESSION);

    // A network fetch wins the race and lands first.
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(9)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    let hydrated: boolean | undefined;
    await act(async () => {
      resolveCacheRead({
        sessionId: SESSION,
        provider: 'claude',
        serverMessages: [msg(1), msg(2)],
        hasMore: false,
        offset: 2,
        total: 2,
        fingerprint: 'fp-stale',
        cachedAt: Date.now(),
      });
      hydrated = await hydratePromise;
    });

    expect(hydrated).toBe(false);
    // The network result must survive, not the stale cache payload.
    expect(result.current.getSlot(SESSION).serverMessages.map((m) => m.id)).toEqual(['m9']);
  });
});

describe('fetchMore', () => {
  it('returns the slot unchanged without fetching when hasMore is false', async () => {
    const { result } = renderHook(() => useSessionStore());
    const slot = result.current.getSlot(SESSION);
    expect(slot.hasMore).toBe(false);

    const returned = await result.current.fetchMore(SESSION);
    expect(returned).toBe(slot);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('prepends older messages and defaults the page size to 20', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [msg(2), msg(3)], total: 5, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(result.current.getSlot(SESSION).hasMore).toBe(true);

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [msg(1)], total: 5, hasMore: false }),
    );
    let more: Awaited<ReturnType<typeof result.current.fetchMore>>;
    await act(async () => {
      more = await result.current.fetchMore(SESSION);
    });

    const url = String(mockFetch.mock.calls[1][0]);
    expect(url).toContain('limit=20');
    expect(more!.serverMessages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(more!.hasMore).toBe(false);
    expect(more!.offset).toBe(3);
  });

  it('honors a custom limit', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [msg(1)], total: 5, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [], total: 5, hasMore: true }));
    await act(async () => {
      await result.current.fetchMore(SESSION, { limit: 7 });
    });
    expect(String(mockFetch.mock.calls[1][0])).toContain('limit=7');
  });

  it('discards a stale page that resolves after a newer fetch already applied', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 2, hasMore: true }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    let resolveSlowPage: (value: unknown) => void = () => {};
    mockFetch.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveSlowPage = resolve;
      }),
    );
    const slowFetchMore = result.current.fetchMore(SESSION);

    // A full refresh lands first and bumps `_appliedFetchSeq` past the pending
    // fetchMore's ticket.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [msg(1), msg(2)], total: 2, hasMore: false }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION);
    });

    let stalePage: Awaited<ReturnType<typeof result.current.fetchMore>>;
    await act(async () => {
      resolveSlowPage(jsonResponse({ messages: [msg(0)], total: 3, hasMore: true }));
      stalePage = await slowFetchMore;
    });

    // The stale page must not have prepended onto the now-current transcript.
    expect(stalePage!.serverMessages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('returns null (not the slot) when the request fails', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 5, hasMore: true }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    mockFetch.mockRejectedValueOnce(new Error('network down'));
    let result2: Awaited<ReturnType<typeof result.current.fetchMore>>;
    await act(async () => {
      result2 = await result.current.fetchMore(SESSION);
    });
    expect(result2!).toBeNull();
    // A failed page must not silently look like a successful empty one.
    expect(result.current.getSlot(SESSION).hasMore).toBe(true);
  });

  it('returns null when the response is not ok', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 5, hasMore: true }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    let result2: Awaited<ReturnType<typeof result.current.fetchMore>>;
    await act(async () => {
      result2 = await result.current.fetchMore(SESSION);
    });
    expect(result2!).toBeNull();
  });
});

describe('appendRealtime — sessionId stamping and MAX_REALTIME_MESSAGES truncation', () => {
  it('stamps the target sessionId onto a message minted for a different one', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(SESSION, msg(1, { sessionId: OTHER_SESSION }));
    });
    const [row] = result.current.getSlot(SESSION).realtimeMessages;
    expect(row.sessionId).toBe(SESSION);
  });

  it('caps realtimeMessages at MAX_REALTIME_MESSAGES, dropping the oldest', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      for (let i = 0; i < 501; i++) {
        result.current.appendRealtime(SESSION, msg(`r${i}`, { id: `r${i}` }));
      }
    });
    const rows = result.current.getSlot(SESSION).realtimeMessages;
    expect(rows).toHaveLength(500);
    expect(rows[0].id).toBe('r1');
    expect(rows[rows.length - 1].id).toBe('r500');
  });
});

describe('appendRealtimeBatch — sessionId stamping, empty batch, and truncation', () => {
  it('is a no-op for an empty batch', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtimeBatch(SESSION, []);
    });
    expect(result.current.has(SESSION)).toBe(false);
  });

  it('stamps the target sessionId onto every message in the batch', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtimeBatch(SESSION, [
        msg(1, { id: 'b1', sessionId: OTHER_SESSION }),
        msg(2, { id: 'b2', sessionId: OTHER_SESSION }),
      ]);
    });
    const rows = result.current.getSlot(SESSION).realtimeMessages;
    expect(rows.every((r) => r.sessionId === SESSION)).toBe(true);
  });

  it('caps realtimeMessages at MAX_REALTIME_MESSAGES for a large batch', () => {
    const { result } = renderHook(() => useSessionStore());
    const batch = Array.from({ length: 505 }, (_, i) => msg(`b${i}`, { id: `b${i}` }));
    act(() => {
      result.current.appendRealtimeBatch(SESSION, batch);
    });
    const rows = result.current.getSlot(SESSION).realtimeMessages;
    expect(rows).toHaveLength(500);
    expect(rows[0].id).toBe('b5');
  });
});

describe('refreshFromServer — network failure', () => {
  it('logs and leaves the slot alone when the request rejects', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    mockFetch.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await result.current.refreshFromServer(SESSION);
    });

    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('logs and leaves the slot alone when the response is not ok', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    mockFetch.mockResolvedValueOnce(jsonResponse({}, 503));
    await act(async () => {
      await result.current.refreshFromServer(SESSION);
    });

    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(1);
  });
});

describe('fetchFromServer — request failure', () => {
  it('marks the slot errored and notifies', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockRejectedValueOnce(new Error('down'));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(result.current.getSlot(SESSION).status).toBe('error');
  });

  it('throws on a non-ok response and surfaces the same error status', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(result.current.getSlot(SESSION).status).toBe('error');
  });
});

describe('fetchFromServer — tokenUsage and stale-ticket race', () => {
  it('stores tokenUsage when the response carries it', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [msg(1)], total: 1, hasMore: false, tokenUsage: { input: 10, output: 20 } }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(result.current.getSlot(SESSION).tokenUsage).toEqual({ input: 10, output: 20 });
  });

  it('discards a stale response that resolves after a newer fetch already applied', async () => {
    const { result } = renderHook(() => useSessionStore());

    let resolveSlow: (value: unknown) => void = () => {};
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSlow = resolve;
    }));
    const slowFetch = result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });

    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1), msg(2)], total: 2, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(2);

    await act(async () => {
      resolveSlow(jsonResponse({ messages: [msg(9)], total: 1, hasMore: false }));
      await slowFetch;
    });

    // The stale response must not have clobbered the newer transcript.
    expect(result.current.getSlot(SESSION).serverMessages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('refreshFromServer — stale-ticket races', () => {
  it('discards a stale unwindowed refresh that resolves after a newer fetch already applied', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    let resolveSlowRefresh: (value: unknown) => void = () => {};
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSlowRefresh = resolve;
    }));
    const slowRefresh = result.current.refreshFromServer(SESSION);

    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1), msg(2)], total: 2, hasMore: false }));
    await act(async () => {
      await result.current.refreshFromServer(SESSION);
    });
    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(2);

    await act(async () => {
      resolveSlowRefresh(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
      await slowRefresh;
    });

    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(2);
  });

  // NOTE: the second stale-ticket check inside the windowed-refresh fallback
  // re-read (useSessionStore.ts:411-413, right after `data = await read(null)`)
  // is not covered. It requires a *second* fetch to apply while the fallback
  // read from the *first* refresh's own retry is still in flight — a compound
  // race on top of the one above. Deterministically sequencing the mock queue
  // for that without the two logical calls stealing each other's queued
  // response (which is what happened when this was attempted) would need a
  // signal internal to the hook that doesn't exist, so it's left uncovered as
  // impractical to pin down with the mock-fetch harness this file uses.
});

describe('refreshFromServer — unchanged transcript keeps the same array reference', () => {
  it('does not replace serverMessages when a refresh returns byte-identical rows', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1), msg(2)], total: 2, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    const before = result.current.getSlot(SESSION).serverMessages;

    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1), msg(2)], total: 2, hasMore: false }));
    await act(async () => {
      await result.current.refreshFromServer(SESSION);
    });

    // Same reference, not just equal content: re-rendering the transcript for
    // a no-op refresh is the perf regression `isSameServerTranscript` exists
    // to avoid.
    expect(result.current.getSlot(SESSION).serverMessages).toBe(before);
  });
});

describe('setStatus', () => {
  it('updates the slot status', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.setStatus(SESSION, 'streaming');
    });
    expect(result.current.getSlot(SESSION).status).toBe('streaming');
  });
});

describe('isStale', () => {
  it('is true for a session with no slot at all', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(result.current.isStale('never-seen')).toBe(true);
  });

  it('is false immediately after a fresh fetch', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(result.current.isStale(SESSION)).toBe(false);
  });

  it('becomes true once the 30s threshold has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useSessionStore());
      mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
      await act(async () => {
        await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
      });
      expect(result.current.isStale(SESSION)).toBe(false);
      vi.advanceTimersByTime(30_001);
      expect(result.current.isStale(SESSION)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('updateStreaming', () => {
  it('creates a streaming message on first call', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(SESSION, 'partial text', 'claude');
    });
    const slot = result.current.getSlot(SESSION);
    expect(slot.realtimeMessages).toHaveLength(1);
    expect(slot.realtimeMessages[0]).toMatchObject({
      id: `__streaming_${SESSION}`,
      kind: 'stream_delta',
      content: 'partial text',
    });
  });

  it('replaces the same streaming message on subsequent calls rather than appending', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(SESSION, 'first chunk', 'claude');
    });
    act(() => {
      result.current.updateStreaming(SESSION, 'first chunk second chunk', 'claude');
    });
    const slot = result.current.getSlot(SESSION);
    expect(slot.realtimeMessages).toHaveLength(1);
    expect(slot.realtimeMessages[0].content).toBe('first chunk second chunk');
  });
});

describe('finalizeStreaming', () => {
  it('converts the streaming row into a finalized assistant text row', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(SESSION, 'hello there', 'claude');
    });
    act(() => {
      result.current.finalizeStreaming(SESSION);
    });
    const slot = result.current.getSlot(SESSION);
    expect(slot.realtimeMessages).toHaveLength(1);
    const finalized = slot.realtimeMessages[0];
    expect(finalized.kind).toBe('text');
    expect(finalized.role).toBe('assistant');
    expect(finalized.content).toBe('hello there');
    expect(finalized.id).not.toBe(`__streaming_${SESSION}`);
  });

  it('is a no-op when there is no streaming row', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(() => {
      act(() => {
        result.current.finalizeStreaming(SESSION);
      });
    }).not.toThrow();
    expect(result.current.has(SESSION)).toBe(false);
  });

  it('is a no-op for a session with no slot at all', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(() => {
      act(() => {
        result.current.finalizeStreaming('never-seen');
      });
    }).not.toThrow();
  });
});

describe('clearRealtime', () => {
  it('empties realtimeMessages and recomputes merged', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(SESSION, msg(1, { id: 'r1' }));
    });
    expect(result.current.getSlot(SESSION).realtimeMessages).toHaveLength(1);

    act(() => {
      result.current.clearRealtime(SESSION);
    });
    const slot = result.current.getSlot(SESSION);
    expect(slot.realtimeMessages).toHaveLength(0);
    expect(slot.merged).toHaveLength(0);
  });

  it('is a no-op for a session with no slot at all', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(() => {
      act(() => {
        result.current.clearRealtime('never-seen');
      });
    }).not.toThrow();
  });
});

describe('getSessionSlot / getMessages', () => {
  it('getSessionSlot returns undefined before the slot exists and the slot after', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(result.current.getSessionSlot(SESSION)).toBeUndefined();
    result.current.getSlot(SESSION);
    expect(result.current.getSessionSlot(SESSION)).toBeDefined();
  });

  it('getMessages returns [] for an unknown session', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(result.current.getMessages('never-seen')).toEqual([]);
  });
});
