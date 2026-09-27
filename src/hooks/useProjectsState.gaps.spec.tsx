import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../contexts/WebSocketContext';

const projectsFetch = vi.fn();
const projectSessionsFetch = vi.fn();
const sessionDetailsFetch = vi.fn();

vi.mock('@/utils/api', () => ({
  api: {
    projects: (...args: unknown[]) => projectsFetch(...args),
    projectSessions: (...args: unknown[]) => projectSessionsFetch(...args),
    sessionDetails: (...args: unknown[]) => sessionDetailsFetch(...args),
  },
  authenticatedFetch: vi.fn(),
  isValidRefreshedToken: () => false,
}));

vi.mock('../utils/api', () => ({
  api: {
    projects: (...args: unknown[]) => projectsFetch(...args),
    projectSessions: (...args: unknown[]) => projectSessionsFetch(...args),
    sessionDetails: (...args: unknown[]) => sessionDetailsFetch(...args),
  },
  authenticatedFetch: vi.fn(),
  isValidRefreshedToken: () => false,
}));

const { useProjectsState } = await import('./useProjectsState');

type Emit = (event: ServerEvent) => void;

function projectPayload(projectId: string, sessionIds: string[], total?: number) {
  return [
    {
      projectId,
      displayName: projectId.toUpperCase(),
      path: `/repos/${projectId}`,
      fullPath: `/repos/${projectId}`,
      isStarred: false,
      sessions: sessionIds.map((id) => ({ id, summary: id, lastActivity: '2026-07-26T00:00:00.000Z' })),
      sessionMeta: { hasMore: (total ?? sessionIds.length) > sessionIds.length, total: total ?? sessionIds.length },
    },
  ];
}

function respondWith(projectId: string, sessionIds: string[], total?: number) {
  projectsFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => projectPayload(projectId, sessionIds, total),
  } as unknown as Response);
}

function mountHook(overrides: Partial<{ sessionId: string; isMobile: boolean }> = {}) {
  let emit: Emit = () => {};
  const subscribe = (listener: Emit) => {
    emit = listener;
    return () => {};
  };
  const navigate = vi.fn();

  const view = renderHook(
    (props: { sessionId?: string }) =>
      useProjectsState({
        sessionId: props.sessionId,
        navigate: navigate as never,
        subscribe,
        isMobile: overrides.isMobile ?? false,
        activeSessions: new Map(),
      }),
    { initialProps: { sessionId: overrides.sessionId } },
  );

  return { ...view, emit: (event: ServerEvent) => emit(event), navigate };
}

describe('useProjectsState — session/project handlers', () => {
  beforeEach(() => {
    projectsFetch.mockReset();
    projectSessionsFetch.mockReset();
    sessionDetailsFetch.mockReset();
    localStorage.clear();
  });

  it('falls back to chat when a stale persisted activeTab names the removed Files tab', async () => {
    localStorage.setItem('activeTab', 'files');
    respondWith('p1', ['s1']);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    expect(result.current.activeTab).toBe('chat');
  });

  it('handleProjectSelect selects a project, clears the session and navigates home', async () => {
    respondWith('p1', ['s1']);
    const { result, navigate } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleSessionSelect(result.current.projects[0].sessions![0]);
    });
    expect(result.current.selectedSession?.id).toBe('s1');

    act(() => {
      result.current.handleProjectSelect(result.current.projects[0]);
    });

    expect(result.current.selectedProject?.projectId).toBe('p1');
    expect(result.current.selectedSession).toBeNull();
    expect(navigate).toHaveBeenLastCalledWith('/');
  });

  it('handleProjectSelect closes the sidebar on mobile', async () => {
    respondWith('p1', ['s1']);
    const { result } = mountHook({ isMobile: true });
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.setSidebarOpen(true);
    });
    act(() => {
      result.current.handleProjectSelect(result.current.projects[0]);
    });
    expect(result.current.sidebarOpen).toBe(false);
  });

  it('handleSessionSelect navigates to the session and closes the sidebar on mobile when project changes', async () => {
    respondWith('p1', ['s1']);
    const { result, navigate } = mountHook({ isMobile: true });
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.setSidebarOpen(true);
    });
    act(() => {
      result.current.handleSessionSelect({ ...result.current.projects[0].sessions![0], __projectId: 'other-project' });
    });

    expect(navigate).toHaveBeenLastCalledWith('/session/s1');
    expect(result.current.sidebarOpen).toBe(false);
  });

  it('handleSessionSelect keeps the sidebar open on mobile when the project is unchanged', async () => {
    respondWith('p1', ['s1']);
    const { result } = mountHook({ isMobile: true });
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleProjectSelect(result.current.projects[0]);
    });
    act(() => {
      result.current.setSidebarOpen(true);
    });
    act(() => {
      result.current.handleSessionSelect({
        ...result.current.projects[0].sessions![0],
        __projectId: result.current.selectedProject?.projectId,
      });
    });
    expect(result.current.sidebarOpen).toBe(true);
  });

  it('handleNewSession selects the project, clears session and bumps the trigger, falling back from a stale persisted tab', async () => {
    localStorage.setItem('activeTab', 'git');
    respondWith('p1', ['s1']);
    const { result, navigate } = mountHook({ isMobile: true });
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    expect(result.current.activeTab).toBe('chat');
    const before = result.current.newSessionTrigger;

    act(() => {
      result.current.handleNewSession(result.current.projects[0]);
    });

    expect(result.current.selectedProject?.projectId).toBe('p1');
    expect(result.current.selectedSession).toBeNull();
    expect(result.current.activeTab).toBe('chat');
    expect(result.current.newSessionTrigger).toBe(before + 1);
    expect(navigate).toHaveBeenLastCalledWith('/');
    expect(result.current.sidebarOpen).toBe(false);
  });

  it('handleSessionDelete clears the selection and navigates home when deleting the active session', async () => {
    respondWith('p1', ['s1', 's2']);
    const { result, navigate } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleSessionSelect(result.current.projects[0].sessions![0]);
    });
    act(() => {
      result.current.handleSessionDelete('s1');
    });

    expect(result.current.selectedSession).toBeNull();
    expect(navigate).toHaveBeenLastCalledWith('/');
    expect(result.current.projects[0].sessions?.map((s) => s.id)).toEqual(['s2']);
    // A single project auto-selects itself; the deleted session is pruned from it too.
    expect(result.current.selectedProject?.sessions?.map((s) => s.id)).toEqual(['s2']);
  });

  it('handleSessionDelete prunes the session from an already-selected project', async () => {
    respondWith('p1', ['s1', 's2']);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleProjectSelect(result.current.projects[0]);
    });
    act(() => {
      result.current.handleSessionDelete('s1');
    });

    expect(result.current.selectedProject?.sessions?.map((s) => s.id)).toEqual(['s2']);
  });

  it('handleSessionDelete leaves the selection alone when deleting an inactive session', async () => {
    respondWith('p1', ['s1', 's2']);
    const { result, navigate } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleSessionSelect(result.current.projects[0].sessions![0]);
    });
    navigate.mockClear();
    act(() => {
      result.current.handleSessionDelete('s2');
    });

    expect(result.current.selectedSession?.id).toBe('s1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('handleProjectDelete clears selection and navigates home when deleting the selected project', async () => {
    respondWith('p1', ['s1']);
    const { result, navigate } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleProjectSelect(result.current.projects[0]);
    });
    act(() => {
      result.current.handleProjectDelete('p1');
    });

    expect(result.current.projects).toHaveLength(0);
    expect(result.current.selectedProject).toBeNull();
    expect(result.current.selectedSession).toBeNull();
    expect(navigate).toHaveBeenLastCalledWith('/');
  });

  it('handleProjectDelete removes an unselected project without touching selection', async () => {
    projectsFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [...projectPayload('p1', ['s1']), ...projectPayload('p2', ['s2'])],
    } as unknown as Response);
    const { result, navigate } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleProjectSelect(result.current.projects.find((p) => p.projectId === 'p1')!);
    });
    navigate.mockClear();
    act(() => {
      result.current.handleProjectDelete('p2');
    });

    expect(result.current.projects.map((p) => p.projectId)).toEqual(['p1']);
    expect(result.current.selectedProject?.projectId).toBe('p1');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('useProjectsState — loadMoreProjectSessions', () => {
  beforeEach(() => {
    projectsFetch.mockReset();
    projectSessionsFetch.mockReset();
    sessionDetailsFetch.mockReset();
  });

  it('appends the next page and keeps selectedProject in sync', async () => {
    respondWith('p1', ['s1'], 2);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleProjectSelect(result.current.projects[0]);
    });

    projectSessionsFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessions: [{ id: 's2', summary: 's2', lastActivity: '2026-07-26T00:00:00.000Z' }],
        sessionMeta: { hasMore: false, total: 2 },
      }),
    } as unknown as Response);

    await act(async () => {
      await result.current.loadMoreProjectSessions('p1');
    });

    expect(result.current.projects[0].sessions?.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.current.selectedProject?.sessions?.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('is a no-op for an unknown project id', async () => {
    respondWith('p1', ['s1']);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    await act(async () => {
      await result.current.loadMoreProjectSessions('does-not-exist');
    });
    expect(projectSessionsFetch).not.toHaveBeenCalled();
  });

  it('is a no-op once every session is already loaded', async () => {
    respondWith('p1', ['s1']);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    await act(async () => {
      await result.current.loadMoreProjectSessions('p1');
    });
    expect(projectSessionsFetch).not.toHaveBeenCalled();
  });

  it('throws a descriptive error when the page request fails with a string error', async () => {
    respondWith('p1', ['s1'], 2);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    projectSessionsFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'boom' }),
    } as unknown as Response);

    await expect(result.current.loadMoreProjectSessions('p1')).rejects.toThrow('boom');
  });

  it('throws a descriptive error when the page request fails with an object error', async () => {
    respondWith('p1', ['s1'], 2);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    projectSessionsFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'nested boom' } }),
    } as unknown as Response);

    await expect(result.current.loadMoreProjectSessions('p1')).rejects.toThrow('nested boom');
  });

  it('falls back to a generic message when the failed response has no error payload', async () => {
    respondWith('p1', ['s1'], 2);
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    projectSessionsFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);

    await expect(result.current.loadMoreProjectSessions('p1')).rejects.toThrow(/Failed to load more sessions/);
  });
});

describe('useProjectsState — deep-link session resolution', () => {
  beforeEach(() => {
    projectsFetch.mockReset();
    projectSessionsFetch.mockReset();
    sessionDetailsFetch.mockReset();
  });

  it('selects the project and session immediately when the session is already loaded', async () => {
    respondWith('p1', ['s1']);
    const { result } = mountHook({ sessionId: 's1' });
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('s1'));
    expect(result.current.selectedProject?.projectId).toBe('p1');
    expect(sessionDetailsFetch).not.toHaveBeenCalled();
  });

  it('looks up an unknown session id via the server and hosts it under the resolved project', async () => {
    respondWith('p1', ['s1']);
    sessionDetailsFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          sessionId: 'unknown',
          provider: 'codex',
          summary: 'Resolved summary',
          project: { projectId: 'p1', path: '/repos/p1', fullPath: '/repos/p1', displayName: 'P1', isStarred: false },
        },
      }),
    } as unknown as Response);

    const { result } = mountHook({ sessionId: 'unknown' });
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('unknown'));
    expect(result.current.selectedSession?.summary).toBe('Resolved summary');
    expect(result.current.selectedSession?.__provider).toBe('codex');
    expect(result.current.selectedProject?.projectId).toBe('p1');
  });

  it('synthesizes a minimal project when the resolved project is not in the loaded list', async () => {
    respondWith('p1', ['s1']);
    sessionDetailsFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessionId: 'unknown',
        provider: 'claude',
        summary: 'Archived session',
        project: { projectId: 'archived', path: '/a', fullPath: '/a', displayName: 'Archived', isStarred: true },
      }),
    } as unknown as Response);

    const { result } = mountHook({ sessionId: 'unknown' });
    await waitFor(() => expect(result.current.selectedProject?.projectId).toBe('archived'));
    expect(result.current.selectedProject?.displayName).toBe('Archived');
    expect(result.current.selectedProject?.sessions).toEqual([]);
  });

  it('redirects to the canonical session id when the URL carried a provider alias', async () => {
    respondWith('p1', ['s1']);
    sessionDetailsFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: 'canonical-id', provider: 'claude', project: null }),
    } as unknown as Response);

    const { navigate } = mountHook({ sessionId: 'alias-id' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/session/canonical-id', { replace: true }));
  });

  it('hosts a placeholder session under the selected project when the lookup fails and a project is selected', async () => {
    respondWith('p1', ['s1']);
    const { result, rerender } = renderHook(
      (props: { sessionId?: string }) =>
        useProjectsState({
          sessionId: props.sessionId,
          navigate: vi.fn() as never,
          subscribe: () => () => {},
          isMobile: false,
          activeSessions: new Map(),
        }),
      { initialProps: { sessionId: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleProjectSelect(result.current.projects[0]);
    });

    sessionDetailsFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as unknown as Response);
    rerender({ sessionId: 'brand-new' });

    await waitFor(() => expect(result.current.selectedSession?.id).toBe('brand-new'));
    expect(result.current.selectedSession?.__projectId).toBe('p1');
  });

  it('does nothing when the lookup fails and no project is selected', async () => {
    respondWith('p1', ['s1']);
    sessionDetailsFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as unknown as Response);

    const { result } = mountHook({ sessionId: 'ghost' });
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));
    expect(result.current.selectedSession).toBeNull();
  });

  it('swallows a thrown lookup error and falls through to the placeholder path', async () => {
    respondWith('p1', ['s1']);
    sessionDetailsFetch.mockRejectedValueOnce(new Error('network down'));

    const { result } = mountHook({ sessionId: 'ghost' });
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));
    expect(result.current.selectedSession).toBeNull();
  });
});

describe('useProjectsState — websocket session_upserted handling', () => {
  beforeEach(() => {
    projectsFetch.mockReset();
    projectSessionsFetch.mockReset();
    sessionDetailsFetch.mockReset();
  });

  it('creates a brand-new project entry from an upsert for a project the client has never seen', async () => {
    respondWith('p1', ['s1']);
    const { result, emit } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      emit({
        kind: 'session_upserted',
        sessionId: 'brand-new',
        provider: 'claude',
        session: { id: 'brand-new', summary: 'new', lastActivity: '2026-07-26T00:00:00.000Z' },
        project: { projectId: 'p2', path: '/repos/p2', fullPath: '/repos/p2', displayName: 'P2', isStarred: false },
        timestamp: '2026-07-26T00:00:01.000Z',
      } as unknown as ServerEvent);
    });

    expect(result.current.projects.map((p) => p.projectId).sort()).toEqual(['p1', 'p2']);
  });

  it('ignores an upsert for an unknown project with no project payload', async () => {
    respondWith('p1', ['s1']);
    const { result, emit } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      emit({
        kind: 'session_upserted',
        sessionId: 'orphan',
        provider: 'claude',
        session: { id: 'orphan', summary: 'x' },
        project: null,
        timestamp: '2026-07-26T00:00:01.000Z',
      } as unknown as ServerEvent);
    });

    expect(result.current.projects).toHaveLength(1);
  });

  it('ignores an upsert event missing sessionId or session', async () => {
    respondWith('p1', ['s1']);
    const { result, emit } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      emit({ kind: 'session_upserted', sessionId: '', provider: 'claude', session: null, project: null } as unknown as ServerEvent);
    });
    expect(result.current.projects[0].sessions?.map((s) => s.id)).toEqual(['s1']);
  });

  it('bumps externalMessageUpdate when the viewed session receives a transcript update and is not active', async () => {
    respondWith('p1', ['s1']);
    const { result, emit } = mountHook();
    await waitFor(() => expect(result.current.isLoadingProjects).toBe(false));

    act(() => {
      result.current.handleSessionSelect(result.current.projects[0].sessions![0]);
    });
    const before = result.current.externalMessageUpdate;

    act(() => {
      emit({
        kind: 'session_upserted',
        sessionId: 's1',
        provider: 'claude',
        session: { id: 's1', summary: 'updated', lastActivity: '2026-07-26T00:01:00.000Z' },
        project: { projectId: 'p1', path: '/repos/p1', fullPath: '/repos/p1', displayName: 'P1', isStarred: false },
        timestamp: '2026-07-26T00:01:00.000Z',
      } as unknown as ServerEvent);
    });

    expect(result.current.externalMessageUpdate).toBe(before + 1);
  });

  it('navigates when a provider-alias upsert matches the currently viewed session id', async () => {
    respondWith('p1', ['alias-id']);
    const { result, navigate, emit } = mountHook({ sessionId: 'alias-id' });
    await waitFor(() => expect(result.current.selectedSession?.id).toBe('alias-id'));

    act(() => {
      emit({
        kind: 'session_upserted',
        sessionId: 'canonical-id',
        providerSessionId: 'alias-id',
        provider: 'claude',
        session: { id: 'canonical-id', summary: 'renamed', lastActivity: '2026-07-26T00:02:00.000Z' },
        project: { projectId: 'p1', path: '/repos/p1', fullPath: '/repos/p1', displayName: 'P1', isStarred: false },
        timestamp: '2026-07-26T00:02:00.000Z',
      } as unknown as ServerEvent);
    });

    expect(navigate).toHaveBeenCalledWith('/session/canonical-id');
    expect(result.current.selectedSession?.summary).toBe('renamed');
  });
});
