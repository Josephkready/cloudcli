import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';

import Sidebar from './Sidebar';

const {
  useSidebarController,
  useDeviceSettings,
  useVersionCheck,
  useUiPreferences,
  usePaletteOps,
} = vi.hoisted(() => ({
  useSidebarController: vi.fn(),
  useDeviceSettings: vi.fn(),
  useVersionCheck: vi.fn(),
  useUiPreferences: vi.fn(),
  usePaletteOps: vi.fn(),
}));

vi.mock('../hooks/useSidebarController', () => ({ useSidebarController }));
vi.mock('../../../hooks/useDeviceSettings', () => ({ useDeviceSettings }));
vi.mock('../../../hooks/useVersionCheck', () => ({ useVersionCheck }));
vi.mock('../../../hooks/useUiPreferences', () => ({ useUiPreferences }));
vi.mock('../../../contexts/PaletteOpsContext', () => ({ usePaletteOps }));

vi.mock('./subcomponents/SidebarCollapsed', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="collapsed">
      <button onClick={props.onExpand as () => void}>expand</button>
      <button onClick={props.onShowSettings as () => void}>settings</button>
    </div>
  ),
}));

let capturedContentProps: Record<string, unknown> = {};
vi.mock('./subcomponents/SidebarContent', () => ({
  default: (props: Record<string, unknown>) => {
    capturedContentProps = props;
    return <div data-testid="content">content</div>;
  },
}));

let capturedModalsProps: Record<string, unknown> = {};
vi.mock('./subcomponents/SidebarModals', () => ({
  default: (props: Record<string, unknown>) => {
    capturedModalsProps = props;
    return <div data-testid="modals">modals</div>;
  },
}));

function makeController(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    isSidebarCollapsed: false,
    expandedProjects: new Set(),
    editingProject: null,
    showNewProject: false,
    editingName: '',
    initialSessionsLoaded: true,
    currentTime: Date.now(),
    isRefreshing: false,
    editingSession: null,
    editingSessionName: '',
    searchFilter: '',
    sidebarOverlay: null,
    setSidebarOverlay: vi.fn(),
    conversationResults: [],
    isSearching: false,
    searchProgress: null,
    runningSessionsCount: 0,
    deletingProjects: new Set(),
    deleteConfirmation: null,
    sessionDeleteConfirmation: null,
    filteredProjects: [],
    archivedProjects: [],
    archivedSessions: [],
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
    toggleProject: vi.fn(),
    handleSessionClick: vi.fn(),
    toggleStarProject: vi.fn(),
    isProjectStarred: vi.fn(),
    getProjectSessions: vi.fn(() => []),
    loadingMoreProjects: new Set(),
    loadMoreSessionsForProject: vi.fn(),
    startEditing: vi.fn(),
    cancelEditing: vi.fn(),
    saveProjectName: vi.fn(),
    showDeleteSessionConfirmation: vi.fn(),
    confirmDeleteSession: vi.fn(),
    archiveSession: vi.fn(),
    requestProjectDelete: vi.fn(),
    confirmDeleteProject: vi.fn(),
    handleProjectSelect: vi.fn(),
    openArchivedSession: vi.fn(),
    restoreArchivedProject: vi.fn(),
    restoreArchivedSession: vi.fn(),
    refreshProjects: vi.fn(),
    updateSessionSummary: vi.fn(),
    collapseSidebar: vi.fn(),
    expandSidebar: vi.fn(),
    setShowNewProject: vi.fn(),
    setEditingName: vi.fn(),
    setEditingSession: vi.fn(),
    setEditingSessionName: vi.fn(),
    setSearchFilter: vi.fn(),
    setDeleteConfirmation: vi.fn(),
    setSessionDeleteConfirmation: vi.fn(),
    ...overrides,
  };
}

const baseSidebarProps = {
  projects: [] as Project[],
  selectedProject: null,
  selectedSession: null,
  activeSessions: new Map(),
  onProjectSelect: vi.fn(),
  onSessionSelect: vi.fn(),
  onNewSession: vi.fn(),
  onSessionDelete: vi.fn(),
  onLoadMoreSessions: vi.fn(),
  onProjectDelete: vi.fn(),
  isLoading: false,
  loadingProgress: null,
  onRefresh: vi.fn(),
  onShowSettings: vi.fn(),
  showSettings: false,
  settingsInitialTab: 'general',
  onCloseSettings: vi.fn(),
  isMobile: false,
};

describe('Sidebar', () => {
  beforeEach(() => {
    capturedContentProps = {};
    capturedModalsProps = {};
    useDeviceSettings.mockReturnValue({ isPWA: false });
    useVersionCheck.mockReturnValue({ restartRequired: false, currentVersion: '1.0.0' });
    useUiPreferences.mockReturnValue({
      preferences: { sidebarVisible: true, spacesExpanded: false },
      setPreference: vi.fn(),
    });
    usePaletteOps.mockReturnValue({ refreshProjects: vi.fn() });
    document.documentElement.classList.remove('pwa-mode');
    document.body.classList.remove('pwa-mode');
  });

  it('renders the collapsed sidebar and wires expand/settings actions', async () => {
    const controller = makeController({ isSidebarCollapsed: true });
    useSidebarController.mockReturnValue(controller);
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<Sidebar {...baseSidebarProps} />);

    expect(screen.getByTestId('collapsed')).toBeInTheDocument();
    expect(screen.queryByTestId('content')).not.toBeInTheDocument();

    await user.click(screen.getByText('expand'));
    expect(controller.expandSidebar).toHaveBeenCalled();

    await user.click(screen.getByText('settings'));
    expect(baseSidebarProps.onShowSettings).toHaveBeenCalled();
  });

  it('renders SidebarContent when expanded and toggles pwa-mode class', () => {
    useDeviceSettings.mockReturnValue({ isPWA: true });
    const controller = makeController();
    useSidebarController.mockReturnValue(controller);

    render(<Sidebar {...baseSidebarProps} />);

    expect(screen.getByTestId('content')).toBeInTheDocument();
    expect(document.documentElement.classList.contains('pwa-mode')).toBe(true);
    expect(document.body.classList.contains('pwa-mode')).toBe(true);
  });

  it('passes projects and delete-confirmation state through to SidebarModals', () => {
    const controller = makeController({ deleteConfirmation: { project: {}, sessionCount: 0 } });
    useSidebarController.mockReturnValue(controller);
    const projects = [{ projectId: 'p1' } as Project];

    render(<Sidebar {...baseSidebarProps} projects={projects} showSettings settingsInitialTab="voice" />);

    expect(capturedModalsProps.projects).toBe(projects);
    expect(capturedModalsProps.showSettings).toBe(true);
    expect(capturedModalsProps.settingsInitialTab).toBe('voice');
    expect(capturedModalsProps.deleteConfirmation).toEqual(controller.deleteConfirmation);
  });

  it('onDeleteArchivedSession maps an archived session into a showDeleteSessionConfirmation call', () => {
    const controller = makeController();
    useSidebarController.mockReturnValue(controller);
    render(<Sidebar {...baseSidebarProps} />);

    const onDeleteArchivedSession = capturedContentProps.onDeleteArchivedSession as (s: unknown) => void;
    onDeleteArchivedSession({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      sessionTitle: 'Archived chat',
      provider: 'claude',
    });

    expect(controller.showDeleteSessionConfirmation).toHaveBeenCalledWith(
      'proj-1',
      'sess-1',
      'Archived chat',
      'claude',
      { isArchived: true },
    );
  });

  it('onConversationResultClick navigates to an existing session within a known project', () => {
    const project = { projectId: 'proj-1', displayName: 'Proj' } as Project;
    const existingSession = { id: 'sess-1' } as ProjectSession;
    const controller = makeController({ getProjectSessions: vi.fn(() => [existingSession]) });
    useSidebarController.mockReturnValue(controller);
    render(<Sidebar {...baseSidebarProps} projects={[project]} />);

    const onConversationResultClick = capturedContentProps.onConversationResultClick as (
      projectId: string | null,
      sessionId: string,
      provider: string,
      messageTimestamp?: string | null,
      messageSnippet?: string | null,
    ) => void;

    onConversationResultClick('proj-1', 'sess-1', 'codex', '2026-01-01', 'snippet');

    expect(controller.handleProjectSelect).toHaveBeenCalledWith(project);
    expect(controller.handleSessionClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-1', __searchTargetTimestamp: '2026-01-01', __searchTargetSnippet: 'snippet' }),
      'proj-1',
    );
  });

  it('onConversationResultClick builds a synthetic session for an unresolved project (null projectId)', () => {
    const controller = makeController();
    useSidebarController.mockReturnValue(controller);
    render(<Sidebar {...baseSidebarProps} />);

    const onConversationResultClick = capturedContentProps.onConversationResultClick as (
      projectId: string | null,
      sessionId: string,
      provider: string,
      messageTimestamp?: string | null,
      messageSnippet?: string | null,
    ) => void;

    onConversationResultClick(null, 'sess-9', '', null, null);

    expect(controller.handleProjectSelect).not.toHaveBeenCalled();
    expect(controller.handleSessionClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-9', __provider: 'claude', __projectId: undefined }),
      '',
    );
  });

  it('onConversationResultClick falls back to a synthetic session when the project has no matching session', () => {
    const project = { projectId: 'proj-1' } as Project;
    const controller = makeController({ getProjectSessions: vi.fn(() => []) });
    useSidebarController.mockReturnValue(controller);
    render(<Sidebar {...baseSidebarProps} projects={[project]} />);

    const onConversationResultClick = capturedContentProps.onConversationResultClick as (
      projectId: string | null,
      sessionId: string,
      provider: string,
    ) => void;

    onConversationResultClick('proj-1', 'sess-missing', 'antigravity');

    expect(controller.handleSessionClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-missing', __provider: 'antigravity', __projectId: 'proj-1' }),
      'proj-1',
    );
  });

  // Sidebar perf audit finding 1: SidebarProjectItem/SidebarSessionItem/
  // SidebarProjectSessions/ConversationRow are React.memo'd downstream, which
  // only holds if the callback props Sidebar.tsx builds are referentially
  // stable across a render that doesn't touch them. This pins that contract
  // directly instead of relying on RowMemoization.render-count.spec.tsx alone
  // (that spec proves memo() behaves correctly given already-stable props; it
  // can't catch a regression in Sidebar.tsx itself, e.g. a useCallback losing
  // its memoization or gaining an unstable dependency).
  it('keeps its callback props referentially stable across an unrelated re-render', () => {
    const controller = makeController();
    useSidebarController.mockReturnValue(controller);

    const { rerender } = render(<Sidebar {...baseSidebarProps} />);
    const before = {
      onDeleteArchivedSession: capturedContentProps.onDeleteArchivedSession,
      onConversationResultClick: capturedContentProps.onConversationResultClick,
      onRefresh: capturedContentProps.onRefresh,
      onCreateProject: capturedContentProps.onCreateProject,
      projectListProps: capturedContentProps.projectListProps as Record<string, unknown>,
    };

    // An unrelated prop change — `settingsInitialTab` only flows to
    // SidebarModals, never into projectListProps or the callbacks above —
    // forces Sidebar to re-render without touching them.
    rerender(<Sidebar {...baseSidebarProps} settingsInitialTab="voice" />);

    expect(capturedContentProps.onDeleteArchivedSession).toBe(before.onDeleteArchivedSession);
    expect(capturedContentProps.onConversationResultClick).toBe(before.onConversationResultClick);
    expect(capturedContentProps.onRefresh).toBe(before.onRefresh);
    expect(capturedContentProps.onCreateProject).toBe(before.onCreateProject);

    // The whole projectListProps object is also stable...
    expect(capturedContentProps.projectListProps).toBe(before.projectListProps);
    // ...specifically because every callback inside it is, which is what
    // actually lets SidebarProjectItem/SidebarProjectSessions/
    // SidebarSessionItem's React.memo skip re-rendering.
    const after = capturedContentProps.projectListProps as Record<string, unknown>;
    for (const key of ['onSaveProjectName', 'onStartEditingSession', 'onCancelEditingSession', 'onSaveEditingSession']) {
      expect(after[key]).toBe(before.projectListProps[key]);
    }
  });
});
