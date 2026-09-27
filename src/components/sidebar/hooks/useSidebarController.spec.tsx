import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaletteOpsProvider } from '../../../contexts/PaletteOpsContext';
import type { ProjectSession } from '../../../types/app';

const searchConversationsUrl = vi.fn((query: string) => `/search?q=${query}`);
const streamAuthenticatedSse = vi.fn();

type MockApiResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

const emptyJsonResponse = (): Promise<MockApiResponse> => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => ({ data: { projects: [], sessions: [] } }),
  text: async () => '',
});

const renameProject = vi.fn();
const deleteProject = vi.fn();
const toggleProjectStar = vi.fn();
const deleteSession = vi.fn();
const restoreProject = vi.fn();
const restoreSession = vi.fn();
const renameSession = vi.fn();
const migrateLegacyProjectStars = vi.fn();
const archivedProjects = vi.fn(emptyJsonResponse);
const getArchivedSessions = vi.fn(emptyJsonResponse);

vi.mock('../../../utils/api', () => ({
  api: {
    archivedProjects: (...args: unknown[]) => (archivedProjects as (...a: unknown[]) => ReturnType<typeof archivedProjects>)(...args),
    getArchivedSessions: (...args: unknown[]) => (getArchivedSessions as (...a: unknown[]) => ReturnType<typeof getArchivedSessions>)(...args),
    searchConversationsUrl,
    renameProject: (...args: unknown[]) => renameProject(...args),
    deleteProject: (...args: unknown[]) => deleteProject(...args),
    toggleProjectStar: (...args: unknown[]) => toggleProjectStar(...args),
    deleteSession: (...args: unknown[]) => deleteSession(...args),
    restoreProject: (...args: unknown[]) => restoreProject(...args),
    restoreSession: (...args: unknown[]) => restoreSession(...args),
    renameSession: (...args: unknown[]) => renameSession(...args),
    migrateLegacyProjectStars: (...args: unknown[]) => migrateLegacyProjectStars(...args),
  },
}));

vi.mock('../../../utils/sse', () => ({
  streamAuthenticatedSse: (...args: unknown[]) => streamAuthenticatedSse(...args),
}));

const { useSidebarController } = await import('./useSidebarController');

type SseCallback = (event: { event: string; data: string }) => void;

const wrapper = ({ children }: { children: ReactNode }) => (
  <PaletteOpsProvider>{children}</PaletteOpsProvider>
);

const args = {
  projects: [],
  selectedProject: null,
  selectedSession: null,
  activeSessions: new Map(),
  isLoading: false,
  isMobile: false,
  t: ((key: string, fallback?: string) => fallback ?? key) as never,
  onRefresh: () => {},
  onProjectSelect: () => {},
  onSessionSelect: () => {},
  setSidebarVisible: () => {},
  sidebarVisible: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  searchConversationsUrl.mockClear();
  streamAuthenticatedSse.mockReset();
  streamAuthenticatedSse.mockImplementation(() => new Promise<void>(() => {}));
});

describe('sidebar conversation-search SSE lifecycle', () => {
  it('streams progress/results, aborts replaced searches, and ignores stale events', async () => {
    const callbacks: SseCallback[] = [];
    const signals: AbortSignal[] = [];
    streamAuthenticatedSse.mockImplementation((_url, callback, options) => {
      callbacks.push(callback as SseCallback);
      signals.push((options as RequestInit).signal as AbortSignal);
      return new Promise<void>(() => {});
    });

    const view = renderHook(() => useSidebarController(args), { wrapper });
    await act(async () => Promise.resolve());
    act(() => {
      view.result.current.setSidebarOverlay('search');
      view.result.current.setSearchFilter('first');
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));

    act(() => callbacks[0]?.({
      event: 'progress',
      data: JSON.stringify({ totalMatches: 0, scannedProjects: 1, totalProjects: 3 }),
    }));
    expect(view.result.current.searchProgress).toEqual({ scannedProjects: 1, totalProjects: 3 });

    act(() => callbacks[0]?.({
      event: 'result',
      data: JSON.stringify({
        projectResult: {
          projectId: 'p1',
          projectName: 'project',
          projectDisplayName: 'Project',
          sessions: [],
        },
        totalMatches: 1,
        scannedProjects: 2,
        totalProjects: 3,
      }),
    }));
    expect(view.result.current.conversationResults?.results).toHaveLength(1);

    act(() => view.result.current.setSearchFilter('second'));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(signals[0]?.aborted).toBe(true);

    act(() => callbacks[0]?.({
      event: 'result',
      data: JSON.stringify({
        projectResult: {
          projectId: 'stale',
          projectName: 'stale',
          projectDisplayName: 'Stale',
          sessions: [],
        },
        totalMatches: 2,
        scannedProjects: 3,
        totalProjects: 3,
      }),
    }));
    expect(view.result.current.conversationResults?.results).toHaveLength(1);

    act(() => callbacks[1]?.({ event: 'error', data: '{}' }));
    expect(signals[1]?.aborted).toBe(true);
    expect(view.result.current.isSearching).toBe(false);
    expect(view.result.current.searchProgress).toBeNull();
  });
});

const makeProject = (overrides: Partial<{
  projectId: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  sessions: ProjectSession[];
}> = {}) => ({
  projectId: 'p1',
  displayName: 'Project One',
  fullPath: '/home/p1',
  isStarred: false,
  sessions: [],
  ...overrides,
});

const okJson = (data: unknown): Promise<MockApiResponse> => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

const failJson = (status: number, data: unknown = {}): Promise<MockApiResponse> => Promise.resolve({
  ok: false,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

describe('sidebar controller actions', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useRealTimers();
    streamAuthenticatedSse.mockReset();
    streamAuthenticatedSse.mockImplementation(() => new Promise<void>(() => {}));
    archivedProjects.mockReset();
    archivedProjects.mockImplementation(emptyJsonResponse);
    getArchivedSessions.mockReset();
    getArchivedSessions.mockImplementation(emptyJsonResponse);
    renameProject.mockReset();
    deleteProject.mockReset();
    toggleProjectStar.mockReset();
    deleteSession.mockReset();
    restoreProject.mockReset();
    restoreSession.mockReset();
    renameSession.mockReset();
    migrateLegacyProjectStars.mockReset();
    localStorage.clear();
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('toggles project expansion exclusively (accordion behavior)', async () => {
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.toggleProject('p1'));
    expect(view.result.current.expandedProjects.has('p1')).toBe(true);

    act(() => view.result.current.toggleProject('p2'));
    expect(view.result.current.expandedProjects.has('p1')).toBe(false);
    expect(view.result.current.expandedProjects.has('p2')).toBe(true);

    act(() => view.result.current.toggleProject('p2'));
    expect(view.result.current.expandedProjects.size).toBe(0);
  });

  it('optimistically stars a project then reconciles with the server response', async () => {
    let resolveToggle!: (value: unknown) => void;
    toggleProjectStar.mockImplementation(() => new Promise((resolve) => { resolveToggle = resolve; }));
    const projects = [makeProject({ isStarred: false })];
    const view = renderHook(() => useSidebarController({ ...args, projects }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.toggleStarProject('p1'));
    expect(view.result.current.isProjectStarred('p1')).toBe(true);

    await act(async () => {
      resolveToggle(await okJson({ isStarred: true }));
    });

    expect(view.result.current.isProjectStarred('p1')).toBe(true);
  });

  it('reverts the optimistic star and alerts when the server rejects the toggle', async () => {
    toggleProjectStar.mockReturnValue(failJson(500, { error: 'nope' }));
    const projects = [makeProject({ isStarred: false })];
    const view = renderHook(() => useSidebarController({ ...args, projects }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.toggleStarProject('p1'));

    await waitFor(() => expect(view.result.current.isProjectStarred('p1')).toBe(false));
    // The catch path always alerts the generic fallback message, discarding the
    // specific error text it just logged to console.error.
    expect(alertSpy).toHaveBeenCalledWith('messages.updateProjectError');
  });

  it('edits a project display name and saves it', async () => {
    renameProject.mockReturnValue(okJson({}));
    const project = makeProject();
    const projects = [project];
    const view = renderHook(() => useSidebarController({ ...args, projects }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.startEditing(project));
    expect(view.result.current.editingProject).toBe('p1');
    expect(view.result.current.editingName).toBe('Project One');

    act(() => view.result.current.setEditingName('Renamed'));
    await act(async () => {
      await view.result.current.saveProjectName('p1');
    });

    expect(renameProject).toHaveBeenCalledWith('p1', 'Renamed');
    expect(view.result.current.editingProject).toBeNull();
  });

  it('cancels editing without saving', async () => {
    const project = makeProject();
    const projects = [project];
    const view = renderHook(() => useSidebarController({ ...args, projects }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.startEditing(project));
    act(() => view.result.current.cancelEditing());

    expect(view.result.current.editingProject).toBeNull();
    expect(view.result.current.editingName).toBe('');
  });

  it('logs when saving a project rename fails at the API level', async () => {
    renameProject.mockReturnValue(failJson(500));
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.saveProjectName('p1');
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to rename project');
  });

  it('requests, then confirms, a project delete (archive path)', async () => {
    deleteProject.mockReturnValue(okJson({}));
    const onProjectDelete = vi.fn();
    const project = makeProject({ sessions: [{ id: 's1' }] });
    const projects = [project];
    const view = renderHook(
      () => useSidebarController({ ...args, projects, onProjectDelete }),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.requestProjectDelete(project));
    expect(view.result.current.deleteConfirmation).toEqual({ project, sessionCount: 1 });

    await act(async () => {
      await view.result.current.confirmDeleteProject(false);
    });

    expect(deleteProject).toHaveBeenCalledWith('p1', false);
    expect(onProjectDelete).toHaveBeenCalledWith('p1');
    expect(view.result.current.deleteConfirmation).toBeNull();
    expect(view.result.current.deletingProjects.has('p1')).toBe(false);
  });

  it('alerts with the server error message when project deletion fails', async () => {
    deleteProject.mockReturnValue(okJson({ error: { message: 'cannot delete' } }).then((r) => ({ ...r, ok: false })));
    const project = makeProject();
    const projects = [project];
    const view = renderHook(() => useSidebarController({ ...args, projects }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.requestProjectDelete(project));
    await act(async () => {
      await view.result.current.confirmDeleteProject(true);
    });

    expect(alertSpy).toHaveBeenCalledWith('cannot delete');
  });

  it('confirmDeleteProject is a no-op with nothing pending', async () => {
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.confirmDeleteProject();
    });

    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('confirms a session delete and refreshes the archive', async () => {
    deleteSession.mockReturnValue(okJson({}));
    const onSessionDelete = vi.fn();
    const view = renderHook(
      () => useSidebarController({ ...args, onSessionDelete }),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));
    archivedProjects.mockClear();

    act(() => view.result.current.showDeleteSessionConfirmation('p1', 's1', 'My session'));
    expect(view.result.current.sessionDeleteConfirmation?.sessionId).toBe('s1');

    await act(async () => {
      await view.result.current.confirmDeleteSession(true);
    });

    expect(deleteSession).toHaveBeenCalledWith('s1', true);
    expect(onSessionDelete).toHaveBeenCalledWith('s1');
    expect(view.result.current.sessionDeleteConfirmation).toBeNull();
  });

  it('alerts when confirming a session delete fails', async () => {
    deleteSession.mockReturnValue(failJson(500));
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.showDeleteSessionConfirmation('p1', 's1', 'My session'));
    await act(async () => {
      await view.result.current.confirmDeleteSession();
    });

    expect(alertSpy).toHaveBeenCalled();
  });

  it('opens an archived session, selecting its matching active project first', async () => {
    const onProjectSelect = vi.fn();
    const onSessionSelect = vi.fn();
    const project = makeProject();
    const projects = [project];
    const view = renderHook(
      () => useSidebarController({ ...args, projects, onProjectSelect, onSessionSelect }),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.openArchivedSession({
      sessionId: 's1',
      sessionTitle: 'Archived',
      projectId: 'p1',
      provider: 'claude',
    } as never));

    expect(onProjectSelect).toHaveBeenCalledWith(project);
    expect(onSessionSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', __projectId: 'p1' }));
  });

  it('restores an archived project and refreshes', async () => {
    restoreProject.mockReturnValue(okJson({}));
    const onRefresh = vi.fn();
    const view = renderHook(() => useSidebarController({ ...args, onRefresh }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.restoreArchivedProject('p1');
    });

    expect(restoreProject).toHaveBeenCalledWith('p1');
    expect(onRefresh).toHaveBeenCalled();
  });

  it('alerts when restoring an archived project fails', async () => {
    restoreProject.mockReturnValue(failJson(500));
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.restoreArchivedProject('p1');
    });

    expect(alertSpy).toHaveBeenCalled();
  });

  it('restores an archived session and refreshes', async () => {
    restoreSession.mockReturnValue(okJson({}));
    const onRefresh = vi.fn();
    const view = renderHook(() => useSidebarController({ ...args, onRefresh }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.restoreArchivedSession('s1');
    });

    expect(restoreSession).toHaveBeenCalledWith('s1');
    expect(onRefresh).toHaveBeenCalled();
  });

  it('alerts when restoring an archived session errors (network throw)', async () => {
    restoreSession.mockRejectedValue(new Error('network down'));
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.restoreArchivedSession('s1');
    });

    expect(alertSpy).toHaveBeenCalled();
  });

  it('refreshes projects and toggles the isRefreshing flag', async () => {
    const onRefresh = vi.fn().mockReturnValue(Promise.resolve());
    const view = renderHook(() => useSidebarController({ ...args, onRefresh }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.refreshProjects();
    });

    expect(onRefresh).toHaveBeenCalled();
    expect(view.result.current.isRefreshing).toBe(false);
  });

  it('renames a session summary and clears editing state', async () => {
    renameSession.mockReturnValue(okJson({}));
    const onRefresh = vi.fn();
    const view = renderHook(() => useSidebarController({ ...args, onRefresh }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.updateSessionSummary('p1', 's1', '  new title  ', 'claude');
    });

    expect(renameSession).toHaveBeenCalledWith('s1', 'new title');
    expect(onRefresh).toHaveBeenCalled();
    expect(view.result.current.editingSession).toBeNull();
  });

  it('skips the rename call for a blank summary', async () => {
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.updateSessionSummary('p1', 's1', '   ', 'claude');
    });

    expect(renameSession).not.toHaveBeenCalled();
  });

  it('alerts when renaming a session fails', async () => {
    renameSession.mockReturnValue(failJson(500));
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.updateSessionSummary('p1', 's1', 'title', 'claude');
    });

    expect(alertSpy).toHaveBeenCalled();
  });

  it('collapses and expands the sidebar via setSidebarVisible', async () => {
    const setSidebarVisible = vi.fn();
    const view = renderHook(() => useSidebarController({ ...args, setSidebarVisible }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.collapseSidebar());
    expect(setSidebarVisible).toHaveBeenCalledWith(false);

    act(() => view.result.current.expandSidebar());
    expect(setSidebarVisible).toHaveBeenCalledWith(true);
  });

  it('reports isSidebarCollapsed only on desktop with a hidden sidebar', async () => {
    const desktopHidden = renderHook(
      () => useSidebarController({ ...args, isMobile: false, sidebarVisible: false }),
      { wrapper },
    );
    expect(desktopHidden.result.current.isSidebarCollapsed).toBe(true);

    const mobileHidden = renderHook(
      () => useSidebarController({ ...args, isMobile: true, sidebarVisible: false }),
      { wrapper },
    );
    expect(mobileHidden.result.current.isSidebarCollapsed).toBe(false);
  });

  // Fixed in this same PR (fix(sidebar): dedupe loadMoreSessionsForProject with
  // a ref, not a setState-updater side effect): the duplicate-load guard used
  // to read a flag mutated inside the `setLoadingMoreProjects` functional
  // updater immediately after calling setState, assuming the updater ran
  // synchronously. React 18 batches all state updates, so that updater never
  // ran in time — the guard always misfired, `onLoadMoreSessions` was never
  // called, and the project got stuck "loading" forever (the early return
  // skipped the `finally` cleanup). The fix tracks in-flight projects in a
  // ref for a synchronous check-and-set, mirrored into state for re-renders.
  it('loads more sessions for a project, guarding against duplicate concurrent loads', async () => {
    let resolveLoad!: () => void;
    const onLoadMoreSessions = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve; }));
    const view = renderHook(
      () => useSidebarController({ ...args, onLoadMoreSessions }),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    let firstCall!: Promise<void>;
    act(() => {
      firstCall = view.result.current.loadMoreSessionsForProject('p1');
    });
    expect(view.result.current.loadingMoreProjects.has('p1')).toBe(true);
    expect(onLoadMoreSessions).toHaveBeenCalledTimes(1);

    // A second request for the same project while the first is in flight must
    // be a no-op — the loading guard should suppress the duplicate call.
    let secondCall!: Promise<void>;
    act(() => {
      secondCall = view.result.current.loadMoreSessionsForProject('p1');
    });
    expect(onLoadMoreSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad();
      await firstCall;
      await secondCall;
    });

    expect(view.result.current.loadingMoreProjects.has('p1')).toBe(false);
  });

  it('alerts when loading more sessions fails, and clears the loading flag', async () => {
    const onLoadMoreSessions = vi.fn().mockRejectedValue(new Error('fail'));
    const view = renderHook(
      () => useSidebarController({ ...args, onLoadMoreSessions }),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.loadMoreSessionsForProject('p1');
    });

    expect(onLoadMoreSessions).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalled();
    expect(view.result.current.loadingMoreProjects.has('p1')).toBe(false);
  });

  it('does nothing when no onLoadMoreSessions handler is supplied', async () => {
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.loadMoreSessionsForProject('p1');
    });

    expect(view.result.current.loadingMoreProjects.has('p1')).toBe(false);
  });

  it('logs an error when the initial archived-sessions fetch fails', async () => {
    archivedProjects.mockReturnValue(failJson(500));
    const view = renderHook(() => useSidebarController(args), { wrapper });

    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[Sidebar] Failed to load archived sessions:',
      expect.any(Error),
    );
  });

  it('migrates legacy starred project ids once, then clears them', async () => {
    localStorage.setItem('starredProjects', JSON.stringify(['legacy-1']));
    migrateLegacyProjectStars.mockReturnValue(Promise.resolve());
    const onRefresh = vi.fn().mockReturnValue(Promise.resolve());

    renderHook(() => useSidebarController({ ...args, onRefresh }), { wrapper });

    await waitFor(() => expect(migrateLegacyProjectStars).toHaveBeenCalledWith(['legacy-1']));
    await waitFor(() => expect(localStorage.getItem('starredProjects')).toBeNull());
  });

  it('filters projects and archived sessions by the search filter', async () => {
    const projects = [
      makeProject({ projectId: 'p1', displayName: 'Alpha' }),
      makeProject({ projectId: 'p2', displayName: 'Bravo' }),
    ];
    const view = renderHook(() => useSidebarController({ ...args, projects }), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    act(() => view.result.current.setSearchFilter('Alpha'));
    await waitFor(() => expect(view.result.current.filteredProjects).toHaveLength(1), { timeout: 3000 });
    expect(view.result.current.filteredProjects[0].projectId).toBe('p1');
  });

  it('archives a session via the shared archiveSession helper', async () => {
    deleteSession.mockReturnValue(okJson({}));
    const view = renderHook(() => useSidebarController(args), { wrapper });
    await waitFor(() => expect(view.result.current.isArchivedSessionsLoading).toBe(false));

    await act(async () => {
      await view.result.current.archiveSession('s1');
    });

    expect(deleteSession).toHaveBeenCalledWith('s1', false);
  });
});
