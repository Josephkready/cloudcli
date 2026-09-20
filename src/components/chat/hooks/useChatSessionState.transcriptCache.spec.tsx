import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '@/types/app';
import type { SessionStore } from '@/stores/useSessionStore';
import type { NormalizedMessage } from '@/stores/useSessionStore.pure';

import { useChatSessionState } from './useChatSessionState';

/*
 * #511 — the on-device transcript cache. Covers the open flow's two branches:
 * a cache HIT paints from IndexedDB (via `hydrateFromCache`) and reconciles with
 * a WINDOWED `refreshFromServer` tail-merge (never a page-0 replace, so older
 * cached pages survive); a MISS falls back to the normal page-0 `fetchFromServer`.
 */

// The hook fetches token usage on mount; irrelevant here, and an undefined
// response would log a failure on every test.
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));

const project = { projectId: 'p1', displayName: 'demo', fullPath: '/repo/demo' } as Project;
const session = { id: 's1', __provider: 'claude' } as ProjectSession;

function makeMessage(index: number): NormalizedMessage {
  return {
    id: `m${index}`,
    sessionId: 's1',
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: `message ${index}`,
  };
}

function setup(hydrateResult: boolean) {
  const slot = {
    hasMore: true,
    total: 44,
    status: 'idle',
    tokenUsage: null,
    serverMessages: [makeMessage(0), makeMessage(1)],
    realtimeMessages: [],
  };

  const sessionStore = {
    has: () => true,
    isStale: () => false,
    getMessages: () => slot.serverMessages,
    getSessionSlot: vi.fn(() => slot),
    setActiveSession: vi.fn(),
    noteProvider: vi.fn(),
    hydrateFromCache: vi.fn(async () => hydrateResult),
    refreshFromServer: vi.fn(async () => undefined),
    fetchFromServer: vi.fn(async () => slot),
    fetchMore: vi.fn(async () => null),
    appendRealtime: vi.fn(),
    clearRealtime: vi.fn(),
  } as unknown as SessionStore;

  const view = renderHook(() =>
    useChatSessionState({
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage: vi.fn(),
      statusCheckSentAtRef: { current: new Map<string, number>() },
      lastSeqRef: { current: new Map<string, number>() },
      sessionStore,
    }),
  );

  return { sessionStore, view };
}

describe('useChatSessionState — transcript cache open flow (#511)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('notes the provider so the store can persist to the cache', async () => {
    const { sessionStore } = setup(false);
    await waitFor(() => expect(sessionStore.noteProvider).toHaveBeenCalledWith('s1', 'claude'));
  });

  it('cache HIT: reconciles with a windowed refreshFromServer, not a page-0 fetch', async () => {
    const { sessionStore, view } = setup(true);

    await waitFor(() => expect(sessionStore.hydrateFromCache).toHaveBeenCalledWith('s1'));
    // The reconcile is a windowed refresh (limit only — a tail-merge that keeps
    // the older cached pages), never the page-0 replace that would drop them.
    await waitFor(() => expect(sessionStore.refreshFromServer).toHaveBeenCalled());
    const refreshArgs = (sessionStore.refreshFromServer as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(refreshArgs[0]).toBe('s1');
    expect(refreshArgs[1]).toEqual({ limit: expect.any(Number) });
    expect(refreshArgs[1]).not.toHaveProperty('offset');
    // A hit paints from cache, so the blocking load state clears.
    await waitFor(() => expect(view.result.current.isLoadingSessionMessages).toBe(false));
    // The page-0 fetch is the miss-path fallback and must not run on a hit.
    expect(sessionStore.fetchFromServer).not.toHaveBeenCalled();
  });

  it('cache MISS: falls back to the normal page-0 fetchFromServer', async () => {
    const { sessionStore } = setup(false);

    await waitFor(() =>
      expect(sessionStore.fetchFromServer).toHaveBeenCalledWith('s1', { limit: expect.any(Number), offset: 0 }),
    );
    // No cache to reconcile — the initial open must not also fire a refresh.
    expect(sessionStore.refreshFromServer).not.toHaveBeenCalled();
  });
});
