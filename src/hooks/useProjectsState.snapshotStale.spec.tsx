import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../contexts/WebSocketContext';

const projectsFetch = vi.fn();
const projectSessionsFetch = vi.fn();

vi.mock('@/utils/api', () => ({
  api: {
    projects: (...args: unknown[]) => projectsFetch(...args),
    projectSessions: (...args: unknown[]) => projectSessionsFetch(...args),
  },
  authenticatedFetch: vi.fn(),
  isValidRefreshedToken: () => false,
}));

vi.mock('../utils/api', () => ({
  api: {
    projects: (...args: unknown[]) => projectsFetch(...args),
    projectSessions: (...args: unknown[]) => projectSessionsFetch(...args),
  },
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
    projectSessionsFetch.mockReset();
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

  it('keeps an optimistic session and selection created during a manual refresh', async () => {
    respondWith(['s1']);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleProjectSelect(result.current.projects[0]);
    });

    let resolveRefresh: (value: unknown) => void = () => {};
    projectsFetch.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    let refreshPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      refreshPromise = result.current.handleSidebarRefresh();
      await Promise.resolve();
    });

    act(() => {
      result.current.registerOptimisticSession({
        sessionId: 'optimistic',
        provider: 'claude',
        project: result.current.projects[0],
        summary: 'New conversation',
      });
    });

    await act(async () => {
      resolveRefresh({ ok: true, json: async () => projectPayload(['s1']) });
      await refreshPromise;
    });

    expect(result.current.projects[0]?.sessions?.map((session) => session.id)).toEqual([
      'optimistic',
      's1',
    ]);
    expect(result.current.selectedSession?.id).toBe('optimistic');
  });

  it('does not apply a refresh after the selection moves away and back', async () => {
    respondWith(['s1']);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleProjectSelect(result.current.projects[0]);
    });

    let resolveRefresh: (value: unknown) => void = () => {};
    projectsFetch.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    let refreshPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      refreshPromise = result.current.handleSidebarRefresh();
      await Promise.resolve();
    });

    act(() => {
      result.current.handleProjectSelect({
        ...result.current.projects[0],
        projectId: 'p2',
        displayName: 'P2',
      });
    });
    act(() => {
      result.current.handleProjectSelect({
        ...result.current.projects[0],
        displayName: 'P1 selected again',
      });
    });

    await act(async () => {
      resolveRefresh({ ok: true, json: async () => projectPayload(['s1']) });
      await refreshPromise;
    });

    expect(result.current.selectedProject?.displayName).toBe('P1 selected again');
  });

  it('drops a session deleted by another client when manually refreshed', async () => {
    respondWith(['s1', 'deleted', 's3']);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    projectsFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => projectPayload(['s1', 's3']),
    } as unknown as Response);

    await act(async () => {
      await result.current.handleSidebarRefresh();
    });

    expect(result.current.projects[0]?.sessions?.map((session) => session.id)).toEqual(['s1', 's3']);
    expect(projectsFetch).toHaveBeenLastCalledWith({ sessionsLimit: 3 });
  });

  it('hydrates past the projects endpoint cap before reconciling a deletion', async () => {
    const originalIds = Array.from({ length: 22 }, (_, index) => `s${index + 1}`);
    respondWith(originalIds);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    const remainingIds = originalIds.filter((id) => id !== 's21');
    projectsFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        const [payload] = projectPayload(remainingIds.slice(0, 20));
        return [{ ...payload, sessionMeta: { hasMore: true, total: remainingIds.length } }];
      },
    } as unknown as Response);
    projectSessionsFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessions: projectPayload(['s22'])[0].sessions,
        sessionMeta: { hasMore: false, total: remainingIds.length },
      }),
    } as unknown as Response);

    await act(async () => {
      await result.current.handleSidebarRefresh();
    });

    expect(result.current.projects[0]?.sessions?.map((session) => session.id)).toEqual(remainingIds);
    expect(projectSessionsFetch).toHaveBeenCalledWith('p1', { limit: 1, offset: 20 });
  });
});
