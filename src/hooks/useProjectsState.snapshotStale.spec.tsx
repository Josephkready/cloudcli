import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../contexts/WebSocketContext';

const projectsFetch = vi.fn();

vi.mock('@/utils/api', () => ({
  api: { projects: (...args: unknown[]) => projectsFetch(...args) },
  authenticatedFetch: vi.fn(),
  isValidRefreshedToken: () => false,
}));

vi.mock('../utils/api', () => ({
  api: { projects: (...args: unknown[]) => projectsFetch(...args) },
  authenticatedFetch: vi.fn(),
  isValidRefreshedToken: () => false,
}));

const { useProjectsState } = await import('./useProjectsState');

/*
 * #302: the first `/api/projects` no longer waits for the server to rescan the
 * provider transcript roots — it serves the persisted SQLite snapshot. The
 * server finishes that scan in the background and emits `projects_snapshot_stale`
 * when it indexed something. This hook is what closes that loop, so it must
 * refetch on the signal, and must do it *silently* — the sidebar is already on
 * screen, and flipping back to "Setting up your workspace…" would be a worse
 * regression than the delay the change removes.
 */

type Emit = (event: ServerEvent) => void;

function projectPayload(sessionIds: string[]) {
  return [
    {
      projectId: 'p1',
      displayName: 'P1',
      path: '/repos/p1',
      fullPath: '/repos/p1',
      isStarred: false,
      sessions: sessionIds.map((id) => ({ id, summary: id, lastActivity: '2026-07-26T00:00:00.000Z' })),
      sessionMeta: { hasMore: false, total: sessionIds.length },
    },
  ];
}

function respondWith(sessionIds: string[]) {
  projectsFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => projectPayload(sessionIds),
  } as unknown as Response);
}

function mountHook() {
  let emit: Emit = () => {};
  const subscribe = (listener: Emit) => {
    emit = listener;
    return () => {};
  };

  const view = renderHook(() =>
    useProjectsState({
      navigate: vi.fn() as never,
      subscribe,
      isMobile: false,
      activeSessions: new Map(),
    }),
  );

  return { ...view, emit: (event: ServerEvent) => emit(event) };
}

describe('useProjectsState — projects_snapshot_stale', () => {
  beforeEach(() => {
    projectsFetch.mockReset();
  });

  it('refetches the project list when the server reports a stale snapshot', async () => {
    respondWith(['s1']);
    const { result, emit } = mountHook();

    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));
    expect(projectsFetch).toHaveBeenCalledTimes(1);

    // The background scan indexed a session written while the server was down.
    respondWith(['s1', 's2']);
    await act(async () => {
      emit({ kind: 'projects_snapshot_stale', timestamp: '2026-07-26T00:00:01.000Z' } as ServerEvent);
    });

    await waitFor(() => expect(projectsFetch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.projects[0]?.sessions?.map((session) => session.id)).toEqual(['s1', 's2']),
    );
  });

  it('does not re-enter the blocking loading state while refreshing', async () => {
    respondWith(['s1']);
    const { result, emit } = mountHook();

    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    let resolveRefresh: (value: unknown) => void = () => {};
    projectsFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    await act(async () => {
      emit({ kind: 'projects_snapshot_stale', timestamp: '2026-07-26T00:00:01.000Z' } as ServerEvent);
    });

    // Mid-flight: the refresh must not have flipped the sidebar back to a spinner.
    expect(result.current.isLoadingProjects).toBe(false);

    await act(async () => {
      resolveRefresh({ ok: true, json: async () => projectPayload(['s1']) });
    });
  });

  it('ignores unrelated event kinds', async () => {
    respondWith(['s1']);
    const { result, emit } = mountHook();

    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    await act(async () => {
      emit({ kind: 'websocket_reconnected', timestamp: Date.now() } as unknown as ServerEvent);
    });

    expect(projectsFetch).toHaveBeenCalledTimes(1);
  });
});
