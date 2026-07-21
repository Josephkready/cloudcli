/**
 * Pure project/session list helpers for `useProjectsState`.
 *
 * These are plain functions over plain data — no React, no fetch, no browser
 * globals — so they can be unit-tested directly. `useProjectsState` owns the
 * state and effects; the session upsert/remove, provider-list dedup and
 * pagination merge rules live here.
 */

import type { ServerEvent } from '../contexts/WebSocketContext';
import type { AppTab, LLMProvider, Project, ProjectSession } from '../types/app';

/**
 * Shape of the per-session sidebar delta broadcast by the backend file
 * watcher (`kind: session_upserted`). It carries everything needed to upsert
 * one session row in place — no full project-list snapshot is ever pushed.
 */
export type SessionUpsertedEvent = ServerEvent & {
  sessionId: string;
  providerSessionId?: string | null;
  provider: LLMProvider;
  session: ProjectSession;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
  } | null;
};

export type ProjectSessionPage = Pick<Project, 'sessions' | 'sessionMeta'>;

export const DEFAULT_PROVIDER: LLMProvider = 'claude';

export const serialize = (value: unknown) => JSON.stringify(value ?? null);

export const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : DEFAULT_PROVIDER;
};

export const normalizeSessionProvider = (session: ProjectSession): ProjectSession => ({
  ...session,
  __provider: getSessionProvider(session),
});

export const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    return (
      nextProject.projectId !== prevProject.projectId ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      Boolean(nextProject.isStarred) !== Boolean(prevProject.isStarred) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions)
    );
  });
};

export const getProjectSessions = (project: Project): ProjectSession[] => {
  return project.sessions ?? [];
};

export const countLoadedProjectSessions = (project: Project): number => getProjectSessions(project).length;

export const mergeSessionProviderLists = (baseSessions: ProjectSession[], additionalSessions: ProjectSession[]): ProjectSession[] => {
  const merged = [...baseSessions];
  const seenSessionIds = new Set(baseSessions.map((session) => String(session.id)));

  for (const session of additionalSessions) {
    const sessionId = String(session.id);
    if (seenSessionIds.has(sessionId)) {
      continue;
    }

    merged.push(session);
    seenSessionIds.add(sessionId);
  }

  return merged;
};

export const mergeExpandedSessionPages = (previousProjects: Project[], incomingProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return incomingProjects;
  }

  const previousByProjectId = new Map(previousProjects.map((project) => [project.projectId, project]));

  return incomingProjects.map((incomingProject) => {
    const previousProject = previousByProjectId.get(incomingProject.projectId);
    if (!previousProject) {
      return incomingProject;
    }

    const previousLoadedCount = countLoadedProjectSessions(previousProject);
    const incomingLoadedCount = countLoadedProjectSessions(incomingProject);
    if (previousLoadedCount <= incomingLoadedCount) {
      return incomingProject;
    }

    const mergedProject: Project = {
      ...incomingProject,
      sessions: mergeSessionProviderLists(incomingProject.sessions ?? [], previousProject.sessions ?? []),
    };

    const totalSessions = Number(incomingProject.sessionMeta?.total ?? previousLoadedCount);
    mergedProject.sessionMeta = {
      ...incomingProject.sessionMeta,
      total: totalSessions,
      hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
    };

    return mergedProject;
  });
};

export const mergeProjectSessionPage = (
  existingProject: Project,
  sessionsPage: ProjectSessionPage,
): Project => {
  const mergedProject: Project = {
    ...existingProject,
    sessions: mergeSessionProviderLists(existingProject.sessions ?? [], sessionsPage.sessions ?? []),
  };

  const totalSessions = Number(sessionsPage.sessionMeta?.total ?? existingProject.sessionMeta?.total ?? 0);
  mergedProject.sessionMeta = {
    ...existingProject.sessionMeta,
    ...sessionsPage.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
  };

  return mergedProject;
};

export const getSessionAliasIds = (event: SessionUpsertedEvent): Set<string> => {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }

    const trimmed = value.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  };

  add(event.sessionId);
  add(event.providerSessionId);
  add(event.session?.id);

  return ids;
};

/**
 * Upserts one session into a project's normalized session list.
 *
 * Existing rows are updated in place (summary/lastActivity changes from the
 * watcher); new rows are prepended since the watcher only fires for sessions
 * with fresh activity. `sessionMeta.total` grows only on insert.
 */
export const upsertSessionIntoProject = (project: Project, event: SessionUpsertedEvent): Project => {
  const sessions = project.sessions ?? [];
  const aliasIds = getSessionAliasIds(event);
  const normalizedSession: ProjectSession = {
    ...event.session,
    id: event.sessionId,
    __provider: event.provider,
  };
  const existingIndex = sessions.findIndex((session) => aliasIds.has(String(session.id)));

  let nextSessions: ProjectSession[];
  let inserted = false;
  if (existingIndex >= 0) {
    let changed = false;
    nextSessions = [];

    for (const [index, session] of sessions.entries()) {
      if (index === existingIndex) {
        const updated = { ...session, ...normalizedSession };
        // Never let a later upsert that carries an empty summary blank out a
        // title we already have. Fresh sessions momentarily broadcast an empty
        // custom_name before the disk indexer fills it in, which would
        // otherwise flash the row back to the "New session" placeholder.
        if (!normalizedSession.summary?.trim() && session.summary?.trim()) {
          updated.summary = session.summary;
        }
        if (serialize(session) !== serialize(updated)) {
          changed = true;
        }
        nextSessions.push(updated);
        continue;
      }

      if (aliasIds.has(String(session.id))) {
        changed = true;
        continue;
      }

      nextSessions.push(session);
    }

    if (!changed) {
      return project;
    }
  } else {
    nextSessions = [normalizedSession, ...sessions];
    inserted = true;
  }

  const next: Project = { ...project, sessions: nextSessions };
  if (inserted) {
    const total = Number(project.sessionMeta?.total ?? 0) + 1;
    next.sessionMeta = {
      ...project.sessionMeta,
      total,
      hasMore: countLoadedProjectSessions(next) < total,
    };
  }

  return next;
};

export const projectFromRegistration = (project: Project): Project => ({
  projectId: project.projectId,
  path: project.path || project.fullPath,
  fullPath: project.fullPath || project.path || '',
  displayName: project.displayName,
  isStarred: project.isStarred,
  sessions: project.sessions ?? [],
  sessionMeta: project.sessionMeta ?? { hasMore: false, total: countLoadedProjectSessions(project) },
});

export const removeSessionFromProject = (project: Project, sessionIdToDelete: string): Project => {
  const sessions = project.sessions ?? [];
  const nextSessions = sessions.filter((session) => session.id !== sessionIdToDelete);
  if (nextSessions.length === sessions.length) {
    return project;
  }

  const updatedProject: Project = {
    ...project,
    sessions: nextSessions,
  };

  const totalSessions = Math.max(0, Number(project.sessionMeta?.total ?? 0) - 1);
  updatedProject.sessionMeta = {
    ...project.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(updatedProject) < totalSessions,
  };

  return updatedProject;
};

const VALID_TABS: Set<string> = new Set(['chat', 'files', 'shell', 'git']);

export const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab) || tab.startsWith('plugin:');
};
