import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { api } from '../utils/api';
import type { ServerEvent } from '../contexts/WebSocketContext';
import type {
  AppTab,
  LLMProvider,
  LoadingProgress,
  Project,
  ProjectSession,
} from '../types/app';

import type { SessionActivityMap } from './useSessionProtection';
import {
  DEFAULT_PROVIDER,
  countLoadedProjectSessions,
  getProjectSessions,
  isValidTab,
  mergeExpandedSessionPages,
  mergeProjectSessionPage,
  normalizeSessionProvider,
  projectFromRegistration,
  projectsHaveChanges,
  removeSessionFromProject,
  serialize,
  upsertSessionIntoProject,
} from './useProjectsState.pure';
import type { ProjectSessionPage, SessionUpsertedEvent } from './useProjectsState.pure';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  /** Subscription to the unified websocket event stream. */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  isMobile: boolean;
  activeSessions: SessionActivityMap;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

type RegisterOptimisticSessionArgs = {
  sessionId: string;
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

const readSelectedProvider = (): LLMProvider => {
  try {
    const storedProvider = localStorage.getItem('selected-provider');
    return storedProvider ? storedProvider as LLMProvider : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
};

const readPersistedTab = (): AppTab => {
  try {
    const stored = localStorage.getItem('activeTab');
    if (stored && isValidTab(stored)) {
      return stored as AppTab;
    }
  } catch {
    // localStorage unavailable
  }
  return 'chat';
};

export function useProjectsState({
  sessionId,
  navigate,
  subscribe,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);

  useEffect(() => {
    try {
      localStorage.setItem('activeTab', activeTab);
    } catch {
      // Silently ignore storage errors
    }
  }, [activeTab]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  /**
   * `newSessionTrigger` is an explicit, monotonic intent signal for user-driven
   * New Session actions.
   *
   * It exists because `handleNewSession` can be invoked while the app is already in
   * the same visible state (`selectedSession === null`, `activeTab === 'chat'`,
   * route already `/`). In that case, React/router updates are idempotent and no
   * downstream reset logic runs.
   *
   * Usage across the codebase:
   * 1) Produced here in `handleNewSession` via increment (always changes).
   * 2) Returned from this hook and threaded through:
   *    useProjectsState -> AppContent -> MainContent -> ChatInterface.
   * 3) Consumed in `useChatSessionState` as an effect dependency to forcibly clear
   *    chat-local state (`currentSessionId`, pending draft message, streaming flags,
   *    pending session storage keys, pagination/scroll artifacts).
   *
   * Keeping this signal dedicated avoids coupling resets to unrelated counters/events
   * (for example websocket/project refresh updates) that could cause accidental resets.
   */
  const [newSessionTrigger, setNewSessionTrigger] = useState(0);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Ref mirrors for state the websocket subscription handler needs.
   *
   * The subscription is registered once (per `subscribe` identity) and events
   * are dispatched synchronously outside React's render cycle, so the handler
   * must read the latest values through refs instead of stale closures —
   * re-subscribing on every state change would risk missing events.
   */
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  const activeSessionsRef = useRef(activeSessions);
  activeSessionsRef.current = activeSessions;

  // Opening a session clears its durable "Done" (finished-but-unviewed) state.
  // The server also stamps last_viewed_at on the history fetch, but that value
  // only reaches this client on the next projects refresh — so bump it
  // optimistically here for immediate feedback. A later re-completion re-marks
  // Done, since last_completed_at moves ahead of this timestamp again.
  const markSessionViewed = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) {
      return;
    }

    const id = String(targetSessionId);
    const viewedAt = new Date().toISOString();

    const bumpProject = (project: Project): Project => {
      const sessions = project.sessions;
      if (!sessions?.some((session) => String(session.id) === id)) {
        return project;
      }
      return {
        ...project,
        sessions: sessions.map((session) =>
          String(session.id) === id ? { ...session, last_viewed_at: viewedAt } : session,
        ),
      };
    };

    setProjects((previous) => previous.map(bumpProject));
    setSelectedProject((previous) => (previous ? bumpProject(previous) : previous));
  }, []);

  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects();
      const projectData = (await response.json()) as Project[];

      setProjects((prevProjects) => {
        const mergedProjects = mergeExpandedSessionPages(prevProjects, projectData);

        if (prevProjects.length === 0) {
          return mergedProjects;
        }

        return projectsHaveChanges(prevProjects, mergedProjects)
          ? mergedProjects
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  const registerOptimisticSession = useCallback(({
    sessionId: newSessionId,
    provider,
    project,
    summary,
  }: RegisterOptimisticSessionArgs) => {
    if (!newSessionId || !project?.projectId) {
      return;
    }

    const now = new Date().toISOString();
    const optimisticSession: ProjectSession = {
      id: newSessionId,
      summary: summary ?? '',
      messageCount: 0,
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      __provider: provider,
      __projectId: project.projectId,
    };
    const upsert: SessionUpsertedEvent = {
      kind: 'session_upserted',
      sessionId: newSessionId,
      provider,
      session: optimisticSession,
      project: {
        projectId: project.projectId,
        path: project.path || project.fullPath,
        fullPath: project.fullPath || project.path || '',
        displayName: project.displayName,
        isStarred: Boolean(project.isStarred),
      },
      timestamp: now,
    };

    setProjects((previousProjects) => {
      const existingProject = previousProjects.find((candidate) => candidate.projectId === project.projectId);
      if (!existingProject) {
        return [upsertSessionIntoProject(projectFromRegistration(project), upsert), ...previousProjects];
      }

      const updatedProject = upsertSessionIntoProject(existingProject, upsert);
      if (updatedProject === existingProject) {
        return previousProjects;
      }

      return previousProjects.map((candidate) =>
        candidate.projectId === existingProject.projectId ? updatedProject : candidate,
      );
    });

    setSelectedProject((previousProject) => {
      if (!previousProject || previousProject.projectId !== project.projectId) {
        return previousProject;
      }

      const updatedProject = upsertSessionIntoProject(previousProject, upsert);
      return updatedProject === previousProject ? previousProject : updatedProject;
    });

    setSelectedSession((previousSession) => (
      previousSession?.id === newSessionId
        ? { ...previousSession, ...optimisticSession }
        : optimisticSession
    ));
  }, []);

  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  // Realtime sidebar updates. The backend pushes per-session deltas
  // (`session_upserted`) instead of full project snapshots, so each event is
  // a keyed upsert that can never clobber unrelated client state — no
  // "suppress updates while a run is active" protection is needed anymore.
  useEffect(() => {
    const handleEvent = (event: ServerEvent) => {
      if (event.kind === 'loading_progress') {
        if (loadingProgressTimeoutRef.current) {
          clearTimeout(loadingProgressTimeoutRef.current);
          loadingProgressTimeoutRef.current = null;
        }

        setLoadingProgress(event as unknown as LoadingProgress);

        if (event.phase === 'complete') {
          loadingProgressTimeoutRef.current = setTimeout(() => {
            setLoadingProgress(null);
            loadingProgressTimeoutRef.current = null;
          }, 500);
        }

        return;
      }

      // Attention is no longer tracked per-tab from websocket events. The sidebar
      // derives Blocked from the live server `blocked` flag and Done from the
      // persisted last_completed_at/last_viewed_at (conversationList.resolveStatus),
      // so this handler only reloads the viewed session's transcript when it
      // changes on disk underneath us.
      if (event.kind !== 'session_upserted') {
        return;
      }

      const upsert = event as SessionUpsertedEvent;
      if (!upsert.sessionId || !upsert.session) {
        return;
      }

      // A transcript write is a passive "changed on disk" signal. It never
      // affects status (Blocked/Done are server-derived, see resolveStatus); we
      // only reload the chat view when the *viewed* session's transcript changed
      // underneath us.
      const currentSelectedSession = selectedSessionRef.current;
      if (
        currentSelectedSession
        && upsert.sessionId === currentSelectedSession.id
        && !activeSessionsRef.current.has(upsert.sessionId)
      ) {
        setExternalMessageUpdate((prev) => prev + 1);
      }

      setProjects((previousProjects) => {
        const targetProjectId = upsert.project?.projectId;
        const existingProject = previousProjects.find((project) =>
          targetProjectId ? project.projectId === targetProjectId : getProjectSessions(project).some((session) => session.id === upsert.sessionId),
        );

        if (!existingProject) {
          // First session of a project this client has never seen: create the
          // project entry from the event payload.
          if (!upsert.project) {
            return previousProjects;
          }

          const newProject: Project = {
            projectId: upsert.project.projectId,
            path: upsert.project.path,
            fullPath: upsert.project.fullPath,
            displayName: upsert.project.displayName,
            isStarred: upsert.project.isStarred,
            sessions: [],
            sessionMeta: { hasMore: false, total: 0 },
          } as Project;

          return [...previousProjects, upsertSessionIntoProject(newProject, upsert)];
        }

        const updatedProject = upsertSessionIntoProject(existingProject, upsert);
        if (updatedProject === existingProject) {
          return previousProjects;
        }

        return previousProjects.map((project) =>
          project.projectId === existingProject.projectId ? updatedProject : project,
        );
      });

      // Keep the selected project reference in sync with the upsert.
      setSelectedProject((previousProject) => {
        if (!previousProject) {
          return previousProject;
        }
        const matches = upsert.project
          ? previousProject.projectId === upsert.project.projectId
          : getProjectSessions(previousProject).some((session) => session.id === upsert.sessionId);
        if (!matches) {
          return previousProject;
        }
        const updated = upsertSessionIntoProject(previousProject, upsert);
        return updated === previousProject ? previousProject : updated;
      });

      const aliasedSelectedSessionId =
        typeof upsert.providerSessionId === 'string' && upsert.providerSessionId !== upsert.sessionId
          ? upsert.providerSessionId
          : null;
      if (!aliasedSelectedSessionId) {
        return;
      }

      const normalizedSelectedSession: ProjectSession = {
        ...upsert.session,
        id: upsert.sessionId,
        __provider: upsert.provider,
        __projectId: upsert.project?.projectId ?? currentSelectedSession?.__projectId,
      };

      setSelectedSession((previousSession) => {
        if (previousSession?.id !== aliasedSelectedSessionId) {
          return previousSession;
        }

        return {
          ...previousSession,
          ...normalizedSelectedSession,
        };
      });

      if (sessionId === aliasedSelectedSessionId) {
        navigate(`/session/${upsert.sessionId}`);
      }
    };

    return subscribe(handleEvent);
  }, [navigate, sessionId, subscribe]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    markSessionViewed(selectedSession?.id ?? sessionId ?? null);
  }, [markSessionViewed, selectedSession?.id, sessionId]);

  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    // Project membership is resolved through `projectId` after the migration.
    for (const project of projects) {
      const match = project.sessions?.find((session) => session.id === sessionId);
      if (match) {
        const normalizedSession = normalizeSessionProvider(match);
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        // Also refresh when the summary changes so a rename (from the chat header,
        // the sidebar, or an AI-authored title) reaches the selected session — the
        // header reads `selectedSession.summary`, not the raw projects payload.
        const shouldUpdateSession =
          selectedSession?.id !== sessionId ||
          selectedSession.__provider !== normalizedSession.__provider ||
          selectedSession.summary !== normalizedSession.summary;

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession(normalizedSession);
        }
        return;
      }
    }

    // Session id is in the URL but not yet present on any project payload
    // (normal for a brand-new conversation: the composer allocates the id and
    // navigates before the sidebar learns about the session via
    // `session_upserted`). Without a `selectedSession`, chat state clears
    // `currentSessionId` and the UI stops reading the session store even
    // though messages stream under this id — so synthesize a placeholder.
    if (selectedSession?.id === sessionId) {
      return;
    }

    // Only the currently selected project may host the placeholder. Guessing
    // another project (e.g. "first one with sessions") could bind the URL
    // session to the wrong project — better to wait until the owning project
    // arrives in a later `projects` payload and is matched by the loop above.
    if (!selectedProject) {
      return;
    }

    setSelectedSession({
      id: sessionId,
      __provider: readSelectedProvider(),
      __projectId: selectedProject.projectId,
      summary: '',
    });
  }, [sessionId, projects, selectedProject, selectedSession?.id, selectedSession?.__provider, selectedSession?.summary]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      markSessionViewed(session.id);
      setSelectedSession(session);

      if (isMobile) {
        // Sessions are tagged with the owning project's DB `projectId` when
        // picked from the sidebar (see useSidebarController); compare against
        // the current selection's `projectId` so we know whether to collapse
        // the sidebar after navigation.
        const sessionProjectId = session.__projectId;
        const currentProjectId = selectedProject?.projectId;

        if (sessionProjectId !== currentProjectId) {
          setSidebarOpen(false);
        }
      }

      navigate(`/session/${session.id}`);
    },
    [markSessionViewed, isMobile, navigate, selectedProject?.projectId],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      setNewSessionTrigger((previous) => previous + 1);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => removeSessionFromProject(project, sessionIdToDelete)),
      );
    },
    [navigate, selectedSession?.id],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const freshProjects = (await response.json()) as Project[];
      const mergedProjects = mergeExpandedSessionPages(projects, freshProjects);

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, mergedProjects) ? mergedProjects : prevProjects,
      );

      if (!selectedProject) {
        return;
      }

      const refreshedProject = mergedProjects.find((project) => project.projectId === selectedProject.projectId);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession =
          refreshedSession.__provider || !selectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: selectedSession.__provider };

        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [projects, selectedProject, selectedSession]);

  const loadMoreProjectSessions = useCallback(async (projectId: string) => {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (!project) {
      return;
    }

    const loadedCount = countLoadedProjectSessions(project);
    const totalCount = Number(project.sessionMeta?.total ?? 0);
    if (totalCount > 0 && loadedCount >= totalCount) {
      return;
    }

    const response = await api.projectSessions(projectId, {
      limit: 20,
      offset: loadedCount,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string | { message?: string } };
      const errorPayload = payload.error;
      const message =
        typeof errorPayload === 'string'
          ? errorPayload
          : errorPayload && typeof errorPayload === 'object' && errorPayload.message
            ? errorPayload.message
            : `Failed to load more sessions for project ${projectId}`;
      throw new Error(message);
    }

    const sessionsPage = (await response.json()) as ProjectSessionPage;

    let mergedProjectForSelection: Project | null = null;
    setProjects((previousProjects) =>
      previousProjects.map((candidate) => {
        if (candidate.projectId !== projectId) {
          return candidate;
        }

        const mergedProject = mergeProjectSessionPage(candidate, sessionsPage);
        mergedProjectForSelection = mergedProject;
        return mergedProject;
      }),
    );

    if (selectedProject?.projectId === projectId && mergedProjectForSelection) {
      setSelectedProject(mergedProjectForSelection);
    }
  }, [projects, selectedProject?.projectId]);

  // `projectId` is the DB identifier passed from the sidebar's delete flow
  // after the migration away from folder-derived project names.
  const handleProjectDelete = useCallback(
    (projectId: string) => {
      if (selectedProject?.projectId === projectId) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.projectId !== projectId));
    },
    [navigate, selectedProject?.projectId],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      activeSessions,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onLoadMoreSessions: loadMoreProjectSessions,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      loadMoreProjectSessions,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      activeSessions,
      projects,
      settingsInitialTab,
      selectedProject,
      selectedSession,
      showSettings,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    loadMoreProjectSessions,
    handleProjectDelete,
    handleSidebarRefresh,
  };
}
