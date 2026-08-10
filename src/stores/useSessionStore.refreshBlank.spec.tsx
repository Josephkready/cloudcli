import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from './useSessionStore';

/*
 * Investigating "the conversation disappears" (cloudcli #173 follow-up).
 *
 * `refreshFromServer` applies whatever the server returned straight over the
 * loaded transcript:
 *
 *     slot.serverMessages = data.messages || [];
 *
 * The server side is not fail-closed. `ClaudeSessionsProvider.fetchHistory`
 * catches EVERY read/parse error and returns a well-formed empty page:
 *
 *     return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
 *
 * So a transient failure reading the JSONL — which Claude Code is appending to
 * throughout a live session — is indistinguishable, on the wire, from "this
 * session genuinely has no messages". If the store applies it, every message
 * the user was reading vanishes.
 */

const mockFetch = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));

const SESSION = 'sess-disappear';

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

beforeEach(() => {
  mockFetch.mockReset();
});

describe('useSessionStore.refreshFromServer — empty/failed refresh (#173)', () => {
  it('loads an initial page', async () => {
    const { result } = renderHook(() => useSessionStore());
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [msg(1), msg(2), msg(3)], total: 3, hasMore: false }),
    );

    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(3);
  });

  it('does NOT blank a loaded transcript when the refresh comes back empty', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [msg(1), msg(2), msg(3)], total: 3, hasMore: false }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(3);

    // The server hit a transient read error and swallowed it into an empty page.
    mockFetch.mockResolvedValueOnce(jsonResponse({ messages: [], total: 0, hasMore: false }));
    await act(async () => {
      await result.current.refreshFromServer(SESSION);
    });

    // The user's conversation must still be on screen.
    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(3);
  });

  it('still applies a refresh that legitimately returns messages', async () => {
    const { result } = renderHook(() => useSessionStore());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [msg(1), msg(2)], total: 2, hasMore: false }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [msg(1), msg(2), msg(3), msg(4)], total: 4, hasMore: false }),
    );
    await act(async () => {
      await result.current.refreshFromServer(SESSION);
    });

    expect(result.current.getSlot(SESSION).serverMessages).toHaveLength(4);
  });
});
