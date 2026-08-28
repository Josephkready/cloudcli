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
