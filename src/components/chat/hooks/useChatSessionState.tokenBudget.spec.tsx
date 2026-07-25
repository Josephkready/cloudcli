import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '@/types/app';
import type { SessionStore } from '@/stores/useSessionStore';

import { readTokenBudgetUsed } from '../utils/tokenBudget';

import { useChatSessionState } from './useChatSessionState';

/*
 * Token usage reads 0 after the first turn of a new session (#240).
 *
 * A brand-new session is created *by* the run, so the frame order is:
 *
 *   seq 4  status/token_budget   → setTokenBudget({inputTokens:100, outputTokens:20})
 *   seq …  session_upserted      → selectedSession.id changes
 *                                → effect fires → GET …/token-usage → {"used":0,…}
 *
 * The REST fetch always lands after the live value and always won — and it
 * returned zeros because the transcript had not been indexed yet. So the first
 * turn of every new chat under-reported as 0, self-correcting only once the user
 * navigated away and back, which reads as "token counting is broken".
 */

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

const LIVE_FRAME = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 };
const UNINDEXED = { used: 0, total: 160000, breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 } };
const INDEXED = { used: 5000, total: 160000, breakdown: { input: 4000, cacheCreation: 0, cacheRead: 1000 } };

const project = { projectId: 'p1', displayName: 'demo', fullPath: '/repo/demo' } as Project;

function makeSessionStore(): SessionStore {
  return {
    has: () => false,
    isStale: () => true,
    getMessages: () => [],
    setActiveSession: vi.fn(),
    appendRealtime: vi.fn(),
    clearRealtime: vi.fn(),
    fetchMore: vi.fn(async () => null),
    refreshFromServer: vi.fn(async () => null),
    fetchFromServer: vi.fn(async () => ({ hasMore: false, total: 0, messages: [] })),
  } as unknown as SessionStore;
}

function renderSessionState(selectedSession: ProjectSession | null) {
  // Identities have to be stable across renders: the hook's effects key off
  // them, and a fresh `vi.fn()` per render would re-run the session-loading
  // effect (and its reset) on every commit.
  const sessionStore = makeSessionStore();
  const sendMessage = vi.fn();
  const resetStreamingState = vi.fn();
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };

  return renderHook(
    ({ session }: { session: ProjectSession | null }) =>
      useChatSessionState({
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage,
        resetStreamingState,
        statusCheckSentAtRef,
        lastSeqRef,
        sessionStore,
      }),
    { initialProps: { session: selectedSession } },
  );
}

function respondWith(body: unknown, ok = true) {
  authenticatedFetch.mockResolvedValue({ ok, json: async () => body } as unknown as Response);
}

describe('useChatSessionState — token budget race (#240)', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
  });

  it('keeps the live token_budget frame when the initial fetch has not been indexed yet', async () => {
    respondWith(UNINDEXED);

    // The run starts before the router has a session: no id yet.
    const { result, rerender } = renderSessionState(null);

    // seq 4 — the live frame the run reported.
    act(() => result.current.setTokenBudget(LIVE_FRAME));
    expect(readTokenBudgetUsed(result.current.tokenBudget)).toBe(120);

    // session_upserted — the id appears, and the initial fetch fires.
    rerender({ session: { id: 'brand-new-session' } as ProjectSession });

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(authenticatedFetch.mock.calls[0][0]).toContain(
        '/api/projects/p1/sessions/brand-new-session/token-usage',
      ),
    );

    // The stale zero must not win.
    await waitFor(() => expect(readTokenBudgetUsed(result.current.tokenBudget)).toBe(120));
  });

  it('lets the server value take over once it has caught up', async () => {
    respondWith(INDEXED);

    const { result, rerender } = renderSessionState(null);
    act(() => result.current.setTokenBudget(LIVE_FRAME));

    rerender({ session: { id: 'brand-new-session' } as ProjectSession });

    await waitFor(() => expect(readTokenBudgetUsed(result.current.tokenBudget)).toBe(5000));
  });

  it('still applies the server value when no live frame arrived', async () => {
    respondWith(INDEXED);

    const { result } = renderSessionState({ id: 'existing-session' } as ProjectSession);

    await waitFor(() => expect(readTokenBudgetUsed(result.current.tokenBudget)).toBe(5000));
  });

  it('does not blank an existing budget when the fetch fails', async () => {
    respondWith({ error: 'nope' }, false);

    const { result, rerender } = renderSessionState(null);
    act(() => result.current.setTokenBudget(LIVE_FRAME));

    rerender({ session: { id: 'brand-new-session' } as ProjectSession });

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    await waitFor(() => expect(readTokenBudgetUsed(result.current.tokenBudget)).toBe(120));
  });

  it('clears the budget when there is no session selected', async () => {
    respondWith(INDEXED);

    const { result, rerender } = renderSessionState({ id: 'existing-session' } as ProjectSession);
    await waitFor(() => expect(result.current.tokenBudget).not.toBeNull());

    rerender({ session: null });

    await waitFor(() => expect(result.current.tokenBudget).toBeNull());
  });
});
