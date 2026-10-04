import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from './useSessionStore';

/*
 * `refreshFromServer(id, { limit })` — the windowed refresh a finished run uses.
 *
 * The unbounded form asks the server to read, normalise and serialise the whole
 * transcript, which on a long conversation is megabytes of JSON shipped after
 * every completed turn just so the streamed rows can be reconciled against
 * their persisted form. The windowed form asks only for the newest N and
 * splices them on.
 *
 * That splice is where a bug would be expensive and quiet: get it wrong and a
 * refresh silently truncates the conversation the user has scrolled back
 * through, which looks exactly like the data loss #173 and #320 were about. So
 * what is pinned here is that a windowed refresh only ever *adds* to the loaded
 * rows, and that the request it sends is actually bounded.
 */

const mockFetch = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));

const SESSION = 'sess-windowed';

function msg(id: number) {
  return {
    id: `m${id}`,
    sessionId: SESSION,
    kind: 'text',
    role: id % 2 === 0 ? 'assistant' : 'user',
    content: `message ${id}`,
    timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(),
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => ({ data: body }) };
}

const requestedUrls = () => mockFetch.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  mockFetch.mockReset();
});

describe('useSessionStore.refreshFromServer — windowed refresh', () => {
  it('asks the server for only the requested window', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 45 });
    });

    expect(requestedUrls()[0]).toContain('limit=45');
    expect(requestedUrls()[0]).toContain('offset=0');
  });

  it('still requests the whole transcript when no limit is given', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [msg(1)], total: 1, hasMore: false }));
    await act(async () => {
      await result.current.refreshFromServer(SESSION);
    });

    expect(requestedUrls()[0]).not.toContain('limit=');
  });

  it('splices the window onto older rows instead of replacing them', async () => {
    const { result } = renderHook(() => useSessionStore());

    // Five rows loaded: a user who has scrolled back through their history.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [1, 2, 3, 4, 5].map(msg), total: 5, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    // A turn finishes; the windowed refresh returns only the newest three, two
    // of which are already loaded.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [4, 5, 6].map(msg), total: 6, hasMore: true }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 3 });
    });

    const slot = result.current.getSlot(SESSION);
    expect(slot.serverMessages.map((message) => message.id)).toEqual([
      'm1', 'm2', 'm3', 'm4', 'm5', 'm6',
    ]);
    // The cursor `fetchMore` walks backwards from must still equal the number
    // of rows actually loaded, or "load older" starts skipping messages.
    expect(slot.offset).toBe(6);
  });

  it('keeps the previous hasMore, which the window cannot speak to', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [1, 2].map(msg), total: 200, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 2, offset: 0 });
    });
    expect(result.current.getSlot(SESSION).hasMore).toBe(true);

    // A page that happens to report `hasMore: false` for its own window must not
    // be read as "this slot now holds the entire conversation" — that would hide
    // the load-older affordance on a 200-message transcript.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [2, 3].map(msg), total: 200, hasMore: false }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 2 });
    });

    expect(result.current.getSlot(SESSION).hasMore).toBe(true);
    expect(result.current.getSlot(SESSION).total).toBe(200);
  });

  it('does not blank a loaded transcript when a windowed refresh comes back empty', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [1, 2, 3].map(msg), total: 3, hasMore: false }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    // Same fail-open server behaviour #173 covers for the unbounded refresh —
    // the guard has to hold for this path too.
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [], total: 0, hasMore: false }));
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 40 });
    });

    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(3);
  });
});

describe('useSessionStore.refreshFromServer — window too small to reach the loaded rows', () => {
  it('re-reads the whole transcript rather than splicing a gap it cannot verify', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [1, 2, 3].map(msg), total: 3, hasMore: false }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    // The run appended more rows than the window covers, so the page starts
    // *after* everything loaded and shares no row with it. Appending it anyway
    // would leave m4/m5 missing forever: `fetchMore` paginates older than the
    // loaded rows, so it walks past the hole rather than into it.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [6, 7].map(msg), total: 7, hasMore: true }),
    );
    // The fallback read, unwindowed.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [1, 2, 3, 4, 5, 6, 7].map(msg), total: 7, hasMore: false }),
    );

    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 2 });
    });

    expect(requestedUrls()[1]).toContain('limit=2');
    expect(requestedUrls()[2]).not.toContain('limit=');
    expect(result.current.getSlot(SESSION).serverMessages.map((message) => message.id)).toEqual([
      'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7',
    ]);
  });

  it('does not re-read when the window does overlap', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [1, 2, 3].map(msg), total: 3, hasMore: false }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [3, 4].map(msg), total: 4, hasMore: false }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 2 });
    });

    // Exactly two requests: the initial load and the windowed refresh. A third
    // would mean the fallback fired on a page that was perfectly spliceable.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.getSlot(SESSION).serverMessages.map((message) => message.id)).toEqual([
      'm1', 'm2', 'm3', 'm4',
    ]);
  });
});

describe('useSessionStore.refreshFromServer — window larger than the loaded rows', () => {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);

  it('splices a page that covers the loaded rows without re-reading the transcript', async () => {
    const { result } = renderHook(() => useSessionStore());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A long session opens with only its newest 20 rows.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(81, 100).map(msg), total: 100, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    // A turn completes and the refresh asks for liveRows + headroom — more
    // than is loaded, so the page's first row (m60) was never loaded.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(60, 102).map(msg), total: 102, hasMore: true }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 43 });
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('re-reading it in full'));
    warn.mockRestore();

    const slot = result.current.getSlot(SESSION);
    expect(slot.serverMessages.map((message) => message.id)).toEqual(
      range(60, 102).map((n) => `m${n}`),
    );
    expect(slot.offset).toBe(43);
    expect(slot.hasMore).toBe(true);
    expect(slot.total).toBe(102);
  });

  it('lets "load older" continue from the covering page without duplicates or gaps', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(81, 100).map(msg), total: 100, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(60, 102).map(msg), total: 102, hasMore: true }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 43 });
    });

    // offset=43 from the newest end of a 102-row transcript is m59 downward.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(40, 59).map(msg), total: 102, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchMore(SESSION, { limit: 20 });
    });

    expect(requestedUrls()[2]).toContain('offset=43');
    const ids = result.current.getSlot(SESSION).serverMessages.map((message) => message.id);
    expect(ids).toEqual(range(40, 102).map((n) => `m${n}`));
  });

  it.each([
    { opened: false, page: true, expected: true },
    { opened: true, page: false, expected: true },
    { opened: false, page: false, expected: false },
  ])('ORs hasMore when the page covers the loaded rows (opened $opened, page $page)', async ({ opened, page, expected }) => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(81, 100).map(msg), total: 100, hasMore: opened }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(60, 102).map(msg), total: 102, hasMore: page }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 43 });
    });

    expect(result.current.getSlot(SESSION).hasMore).toBe(expected);
  });

  it('takes the server hasMore when a windowed refresh is the first load', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(98, 100).map(msg), total: 100, hasMore: true }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 3 });
    });

    const slot = result.current.getSlot(SESSION);
    expect(slot.serverMessages.map((message) => message.id)).toEqual(['m98', 'm99', 'm100']);
    expect(slot.hasMore).toBe(true);
    expect(slot.offset).toBe(3);
  });

  it('keeps a live streaming row and drops a live row the covering page now owns', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(81, 100).map(msg), total: 100, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    act(() => {
      // m101 arrived over the socket and is now persisted; the stream is still open.
      result.current.appendRealtime(SESSION, msg(101) as never);
      result.current.appendRealtime(SESSION, {
        id: `__streaming_${SESSION}`,
        sessionId: SESSION,
        kind: 'stream_delta',
        role: 'assistant',
        content: 'still typing',
        timestamp: new Date(1_700_000_200_000).toISOString(),
      } as never);
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(60, 101).map(msg), total: 101, hasMore: true }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 42 });
    });

    const slot = result.current.getSlot(SESSION);
    expect(slot.realtimeMessages.map((message) => message.id)).toEqual([`__streaming_${SESSION}`]);
    const mergedIds = slot.merged.map((message) => message.id);
    expect(mergedIds.filter((id) => id === 'm101')).toHaveLength(1);
    expect(mergedIds).toContain(`__streaming_${SESSION}`);
    expect(mergedIds[0]).toBe('m60');
  });

  it('still falls back to a full read when the windows are disjoint', async () => {
    const { result } = renderHook(() => useSessionStore());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(81, 100).map(msg), total: 100, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(105, 110).map(msg), total: 110, hasMore: true }),
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: range(1, 110).map(msg), total: 110, hasMore: false }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION, { limit: 6 });
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(requestedUrls()[2]).not.toContain('limit=');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-reading it in full'));
    warn.mockRestore();
    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(110);
  });
});
