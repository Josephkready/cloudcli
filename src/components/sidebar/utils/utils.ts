import type { TFunction } from 'i18next';

import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import type { ProjectSortOrder, SettingsProject, SessionViewModel, SessionWithProvider } from '../types/types';

// Session count is the default: the projects with the most sessions are the
// ones actually worked in, so they lead the list unless the user picked a mode.
export const DEFAULT_PROJECT_SORT_ORDER: ProjectSortOrder = 'count';

const normalizeProjectSortOrder = (value: unknown): ProjectSortOrder => {
  return value === 'name' || value === 'date' || value === 'count'
    ? value
    : DEFAULT_PROJECT_SORT_ORDER;
};

export const readProjectSortOrder = (): ProjectSortOrder => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return DEFAULT_PROJECT_SORT_ORDER;
    }

    const settings = JSON.parse(rawSettings) as { projectSortOrder?: ProjectSortOrder };
    return normalizeProjectSortOrder(settings.projectSortOrder);
  } catch {
    return DEFAULT_PROJECT_SORT_ORDER;
  }
};

/**
 * Hide terminal-started sessions by default (#216). CloudCLI can't drive a
 * session it didn't start and its live status is unknown, so for most users
 * they're noise in the conversation lists. Power users can flip the toggle in
 * Appearance settings to see them again.
 */
export const DEFAULT_HIDE_CLI_ORIGIN_CHATS = true;

/**
 * Reads the "hide CLI-origin chats" preference from the same `claude-settings`
 * blob that carries `projectSortOrder`. Anything other than an explicit boolean
 * (missing key, corrupt JSON, unreadable storage) falls back to the default.
 */
export const readHideCliOriginChats = (): boolean => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return DEFAULT_HIDE_CLI_ORIGIN_CHATS;
    }

    const settings = JSON.parse(rawSettings) as { hideCliOriginChats?: unknown };
    return typeof settings.hideCliOriginChats === 'boolean'
      ? settings.hideCliOriginChats
      : DEFAULT_HIDE_CLI_ORIGIN_CHATS;
  } catch {
    return DEFAULT_HIDE_CLI_ORIGIN_CHATS;
  }
};

/**
 * Drops sessions started outside CloudCLI (`origin === 'cli'`, the marker the
 * "CLI" badge already renders from) when `hide` is set. Returns the input array
 * untouched when the preference is off, so the un-filtered path allocates
 * nothing. Pure, so both the sidebar list and the session tab strip can share
 * one predicate.
 */
export const filterCliOriginSessions = <T extends { origin?: string }>(
  sessions: T[],
  hide: boolean,
): T[] => (hide ? sessions.filter((session) => session.origin !== 'cli') : sessions);

/**
 * Project-level counterpart of {@link filterCliOriginSessions}: rewrites each
 * project's `sessions` with the CLI-origin ones removed. Projects left with no
 * visible session are dropped entirely so the conversation list doesn't render
 * empty spaces.
 */
export const filterCliOriginSessionsFromProjects = (
  projects: Project[],
  hide: boolean,
): Project[] => {
  if (!hide) {
    return projects;
  }

  return projects
    .map((project) => ({
      ...project,
      sessions: filterCliOriginSessions(project.sessions || [], true),
    }))
    .filter((project) => project.sessions.length > 0);
};

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

export const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

export const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

export const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  return (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );
};

export const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'count') {
      // Sort by the same value shown as the count badge on each project row
      // (`SidebarProjectItem`): the true `sessionMeta.total`, falling back to the
      // number of loaded sessions when the meta hasn't been populated yet.
      // Descending so the busiest projects lead.
      const countA = Number(projectA.sessionMeta?.total ?? projectA.sessions?.length ?? 0);
      const countB = Number(projectB.sessionMeta?.total ?? projectB.sessions?.length ?? 0);
      const countDiff = countB - countA;
      if (countDiff !== 0) {
        return countDiff;
      }
      // Tie-break equal counts by name so ordering stays stable/deterministic.
      return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
