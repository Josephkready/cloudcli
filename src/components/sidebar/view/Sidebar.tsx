import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useSidebarController } from '../hooks/useSidebarController';
import type { LLMProvider } from '../../../types/app';
import type { ArchivedSessionListItem, SidebarProps } from '../types/types';

import SidebarCollapsed from './subcomponents/SidebarCollapsed';
import SidebarContent from './subcomponents/SidebarContent';
import SidebarModals from './subcomponents/SidebarModals';
import type { SidebarProjectListProps } from './subcomponents/SidebarProjectList';

function Sidebar({
  projects,
  selectedProject,
  selectedSession,
  activeSessions,
  onProjectSelect,
  onSessionSelect,
  onNewSession,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  isLoading,
  loadingProgress,
  onRefresh,
  onShowSettings,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  isMobile,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const { restartRequired, currentVersion } = useVersionCheck();
  const { preferences, setPreference } = useUiPreferences();
  const { sidebarVisible, spacesExpanded } = preferences;

  const {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    sidebarOverlay,
    setSidebarOverlay,
    conversationResults,
    isSearching,
    searchProgress,
    runningSessionsCount,
    deletingProjects,
    deleteConfirmation,
    sessionDeleteConfirmation,
    filteredProjects,
    archivedProjects,
    archivedSessions,
    archivedSessionsCount,
    isArchivedSessionsLoading,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    loadingMoreProjects,
    loadMoreSessionsForProject,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    archiveSession,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar: handleCollapseSidebar,
    expandSidebar: handleExpandSidebar,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
  } = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
    activeSessions,
    isLoading,
    isMobile,
    t,
    onRefresh,
    onProjectSelect,
    onSessionSelect,
    onSessionDelete,
    onLoadMoreSessions,
    onProjectDelete,
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible,
  });

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  // Stabilized so `React.memo` on the row components (SidebarProjectItem,
  // SidebarSessionItem, SidebarProjectSessions, ConversationRow) actually
  // holds: an inline arrow recreated every Sidebar render would defeat memo
  // just as badly as no memo at all, since it always compares unequal.
  const onSaveProjectName = useCallback(
    (projectName: string) => {
      void saveProjectName(projectName);
    },
    [saveProjectName],
  );

  const onStartEditingSession = useCallback(
    (sessionId: string, initialName: string) => {
      setEditingSession(sessionId);
      setEditingSessionName(initialName);
    },
    [setEditingSession, setEditingSessionName],
  );

  const onCancelEditingSession = useCallback(() => {
    setEditingSession(null);
    setEditingSessionName('');
  }, [setEditingSession, setEditingSessionName]);

  const onSaveEditingSession = useCallback(
    (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => {
      void updateSessionSummary(projectName, sessionId, summary, provider);
    },
    [updateSessionSummary],
  );

  const onDeleteArchivedSession = useCallback(
    (session: ArchivedSessionListItem) => {
      showDeleteSessionConfirmation(
        session.projectId,
        session.sessionId,
        session.sessionTitle,
        session.provider,
        { isArchived: true },
      );
    },
    [showDeleteSessionConfirmation],
  );

  const onConversationResultClick = useCallback(
    (projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => {
      // `projectId` (DB key) is the canonical identifier post-migration.
      // The server emits null when it can't resolve a project row for
      // the search hit; treat that as "no project" and still navigate
      // to the session so the user can open it from the URL.
      const resolvedProvider = (provider || 'claude') as LLMProvider;
      const project = projectId ? projects.find(p => p.projectId === projectId) : null;
      const searchTarget = { __searchTargetTimestamp: messageTimestamp || null, __searchTargetSnippet: messageSnippet || null };
      const sessionObj = {
        id: sessionId,
        __provider: resolvedProvider,
        __projectId: projectId ?? undefined,
        ...searchTarget,
      };
      if (project) {
        handleProjectSelect(project);
        const sessions = getProjectSessions(project);
        const existing = sessions.find(s => s.id === sessionId);
        if (existing) {
          handleSessionClick({ ...existing, ...searchTarget }, project.projectId);
        } else {
          handleSessionClick(sessionObj, project.projectId);
        }
      } else {
        handleSessionClick(sessionObj, projectId ?? '');
      }
    },
    [projects, handleProjectSelect, getProjectSessions, handleSessionClick],
  );

  const onRefreshProjects = useCallback(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const projectListProps: SidebarProjectListProps = useMemo(
    () => ({
      projects,
      filteredProjects,
      selectedProject,
      selectedSession,
      isLoading,
      loadingProgress,
      expandedProjects,
      editingProject,
      editingName,
      initialSessionsLoaded,
      currentTime,
      editingSession,
      editingSessionName,
      deletingProjects,
      getProjectSessions,
      loadingMoreProjects,
      activeSessions,
      isProjectStarred,
      onEditingNameChange: setEditingName,
      onToggleProject: toggleProject,
      onProjectSelect: handleProjectSelect,
      onToggleStarProject: toggleStarProject,
      onStartEditingProject: startEditing,
      onCancelEditingProject: cancelEditing,
      onSaveProjectName,
      onDeleteProject: requestProjectDelete,
      onSessionSelect: handleSessionClick,
      onDeleteSession: showDeleteSessionConfirmation,
      onArchiveSession: archiveSession,
      onLoadMoreSessions: loadMoreSessionsForProject,
      onNewSession,
      onEditingSessionNameChange: setEditingSessionName,
      onStartEditingSession,
      onCancelEditingSession,
      onSaveEditingSession,
      t,
    }),
    [
      projects,
      filteredProjects,
      selectedProject,
      selectedSession,
      isLoading,
      loadingProgress,
      expandedProjects,
      editingProject,
      editingName,
      initialSessionsLoaded,
      currentTime,
      editingSession,
      editingSessionName,
      deletingProjects,
      getProjectSessions,
      loadingMoreProjects,
      activeSessions,
      isProjectStarred,
      setEditingName,
      toggleProject,
      handleProjectSelect,
      toggleStarProject,
      startEditing,
      cancelEditing,
      onSaveProjectName,
      requestProjectDelete,
      handleSessionClick,
      showDeleteSessionConfirmation,
      archiveSession,
      loadMoreSessionsForProject,
      onNewSession,
      setEditingSessionName,
      onStartEditingSession,
      onCancelEditingSession,
      onSaveEditingSession,
      t,
    ],
  );

  return (
    <>
        <SidebarModals
          projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={onCloseSettings}
        deleteConfirmation={deleteConfirmation}
        onCancelDeleteProject={() => setDeleteConfirmation(null)}
        onConfirmDeleteProject={confirmDeleteProject}
        sessionDeleteConfirmation={sessionDeleteConfirmation}
        onCancelDeleteSession={() => setSessionDeleteConfirmation(null)}
        onConfirmDeleteSession={confirmDeleteSession}
        t={t}
      />

      {isSidebarCollapsed ? (
        <SidebarCollapsed
          onExpand={handleExpandSidebar}
          onShowSettings={onShowSettings}
          restartRequired={restartRequired}
          t={t}
        />
      ) : (
        <>
          <SidebarContent
            isPWA={isPWA}
            isMobile={isMobile}
            isLoading={isLoading}
            projects={projects}
            runningSessionsCount={runningSessionsCount}
            archivedProjects={archivedProjects}
            archivedSessions={archivedSessions}
            archivedSessionsCount={archivedSessionsCount}
            isArchivedSessionsLoading={isArchivedSessionsLoading}
            spacesExpanded={spacesExpanded}
            onSpacesExpandedChange={(open) => setPreference('spacesExpanded', open)}
            searchFilter={searchFilter}
            onSearchFilterChange={setSearchFilter}
            onClearSearchFilter={() => setSearchFilter('')}
            sidebarOverlay={sidebarOverlay}
            onSetOverlay={setSidebarOverlay}
            conversationResults={conversationResults}
            isSearching={isSearching}
            searchProgress={searchProgress}
            onRestoreArchivedProject={restoreArchivedProject}
            onArchivedSessionClick={openArchivedSession}
            onRestoreArchivedSession={restoreArchivedSession}
            onDeleteArchivedSession={onDeleteArchivedSession}
            onConversationResultClick={onConversationResultClick}
            onRefresh={onRefreshProjects}
            isRefreshing={isRefreshing}
            onCollapseSidebar={handleCollapseSidebar}
            restartRequired={restartRequired}
            currentVersion={currentVersion}
            onShowSettings={onShowSettings}
            projectListProps={projectListProps}
            t={t}
          />
        </>
      )}

    </>
  );
}

export default Sidebar;
