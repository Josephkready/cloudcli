import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  resolveSessionLiveStatus,
  sessionSynchronizerService,
  deriveSessionOrigin,
  type SessionLiveStatus,
} from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError, isGitRepositoryRoot, isGitWorktree, mapWithConcurrency } from '@/shared/utils.js';

type SessionSummary = {
  id: string;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
  // Durable "Done" (finished-but-unviewed) state: the client derives Done when
  // last_completed_at is set and newer than last_viewed_at. Null = never
  // completed / never viewed.
  last_completed_at: string | null;
  last_viewed_at: string | null;
  // Where the session is driven from (#71). `cloudcli` = created through cloudcli
  // (an app id was allocated, so it differs from the provider-native id, or the
  // provider id isn't assigned yet); `cli` = discovered on disk by the sessions
  // watcher (the row's provider id equals its app id). Lets the sidebar mark
  // externally-driven sessions whose live status cloudcli can't know.
  origin: 'cli' | 'cloudcli';
  // Server-detected live status for sessions cloudcli didn't launch (#21): a
  // bare-terminal `claude` writing the same transcript. Lets the Conversations
  // list rank terminal sessions (blocked/working) like cloudcli-driven ones;
  // client-driven status still wins for sessions cloudcli launched. Defaults to
  // 'idle' and is filled in from the transcript on disk.
  liveStatus: SessionLiveStatus;
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  provider_session_id?: string | null;
  jsonl_path?: string | null;
  project_path?: string | null;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  last_completed_at?: string | null;
  last_viewed_at?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  /**
   * True when the space's folder is a git repository root — the same test the
   * folder picker lists on (#309): a `.git` directory (clone) or a `.git` file
   * (linked worktree / submodule).
   *
   * A space row is created for every session's cwd, so running an agent inside
   * `<repo>/tools/foo` mints a space for that subfolder forever. The
   * new-conversation picker searches spaces, which is how subfolders kept
   * turning up there (#332); this bit is what lets it list repository roots
   * only. It costs one `stat` per space, which is noise next to the
   * package.json read and session page each space already pays for here.
   */
  isRepository: boolean;
  /**
   * True when that repository root is a *linked worktree* rather than a clone —
   * a `.git` file instead of a `.git` directory.
   *
   * Filtering to repository roots was not enough on its own (#344): worktrees
   * are roots, and on a machine running parallel agents they outnumbered the
   * real repositories in the picker. Reported separately rather than folded into
   * `isRepository` because a worktree genuinely is a repository — the picker
   * demotes it behind "show all folders", it isn't lied about.
   */
  isWorktree: boolean;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;
// Bound the per-page live-status disk fan-out (stat + tail read per session). A
// page can be up to MAX_PROJECT_SESSIONS_PAGE_SIZE, so a raw Promise.all could
// open that many file handles at once. Mirrors the synchronizer's bounded fan-out.
const LIVE_STATUS_SCAN_CONCURRENCY = 12;
// Projects are built with bounded fan-out too, so the all-projects response does
// not scale linearly with the workspace count. Kept modest because each project
// in flight opens its own page of live-status probes underneath.
const PROJECT_BUILD_CONCURRENCY = 4;

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(row: SessionRepositoryRow): SessionSummary {
  return {
    id: row.session_id,
    provider: row.provider,
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    last_completed_at: row.last_completed_at ?? null,
    last_viewed_at: row.last_viewed_at ?? null,
    // Best-effort origin heuristic (#71): disk-discovered sessions are inserted
    // with provider_session_id === session_id, while cloudcli-created ones keep a
    // distinct app id (or a not-yet-assigned null provider id). Anything that
    // isn't a confirmed id match is treated as cloudcli-driven.
    // Caveat: the provider_session_id column was backfilled to session_id for all
    // rows predating it (migrations.ts), so sessions created through cloudcli
    // before that migration read as 'cli'. The badge copy is deliberately hedged
    // ("not driven by cloudcli") rather than asserting a terminal origin.
    origin: deriveSessionOrigin(row.session_id, row.provider_session_id),
    // Placeholder; the live variant (buildSessionSummariesWithLiveStatus) fills
    // this in from the transcript on disk. Archived/history reads keep 'idle'.
    liveStatus: 'idle',
  };
}

/**
 * Maps rows to summaries and fills each `liveStatus` from the transcript on disk
 * in parallel. Sharing one `nowMs` keeps every row in a page classified against
 * the same clock. Live-status detection is best-effort (defaults to 'idle'), so
 * a slow or missing transcript never fails the page.
 */
async function buildSessionSummariesWithLiveStatus(
  rows: SessionRepositoryRow[],
): Promise<SessionSummary[]> {
  const nowMs = Date.now();
  return mapWithConcurrency(rows, LIVE_STATUS_SCAN_CONCURRENCY, async (row) => {
    const summary = mapSessionRowToSummary(row);
    summary.liveStatus = await resolveSessionLiveStatus(
      {
        provider: row.provider,
        sessionId: row.session_id,
        jsonlPath: row.jsonl_path ?? null,
        projectPath: row.project_path ?? null,
      },
      nowMs,
    );
    return summary;
  });
}

function readProjectSessionsIncludingArchived(projectPath: string): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    // Archived sessions are history, not live — keep the 'idle' placeholder and
    // skip the per-row disk probe.
    sessions: rows.map(mapSessionRowToSummary),
    total: rows.length,
    hasMore: false,
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
async function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageResult> {
  const pagination = normalizeSessionPagination(options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    sessions: await buildSessionSummariesWithLiveStatus(rows),
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;
  const totalProjects = projectRows.length;
  let processedProjects = 0;

  // Each project costs a package.json read plus a page of live-status probes, and
  // those are independent per project — running them one project at a time made
  // the response scale linearly with the workspace count (#302). Bounded fan-out
  // keeps the disk pressure capped while collapsing the wall clock;
  // mapWithConcurrency preserves input order, so the sidebar ordering is unchanged.
  const projects = await mapWithConcurrency(projectRows, PROJECT_BUILD_CONCURRENCY, async (row) => {
    const projectPath = row.project_path;

    const [displayName, sessionsPage, isRepository, isWorktree] = await Promise.all([
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? Promise.resolve(row.custom_project_name)
        : generateDisplayName(path.basename(projectPath) || projectPath, projectPath),
      readProjectSessionsPageByPath(projectPath, {
        limit: options.sessionsLimit,
        offset: options.sessionsOffset,
      }),
      isGitRepositoryRoot(projectPath),
      isGitWorktree(projectPath),
    ]);

    processedProjects += 1;
    broadcastProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    });

    return {
      projectId: row.project_id,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      isRepository,
      isWorktree,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    } satisfies ProjectListItem;
  });

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects;
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;

  const archivedProjects: ArchivedProjectListItem[] = [];

  for (const row of projectRows) {
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      isRepository: await isGitRepositoryRoot(row.project_path),
      isWorktree: await isGitWorktree(row.project_path),
      isArchived: true,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  return archivedProjects;
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = await readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
