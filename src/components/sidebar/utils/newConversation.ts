import { Folder, FolderPlus } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { Project } from '../../../types/app';
import type { ActionMenuItem } from '../../../shared/view/ui/ActionMenu';

import { sortProjects } from './utils';

type BuildNewConversationItemsArgs = {
  projects: Project[];
  onPickProject: (project: Project) => void;
  /**
   * Opens the create-project flow. Optional because not every surface owns one:
   * that flow is the sidebar's local state, so the mobile landing page (#331)
   * cannot reach it and omits the item rather than rendering a dead control.
   */
  onCreateProject?: () => void;
  /**
   * Include spaces whose folder isn't a repository root. Off by default — see
   * {@link buildNewConversationItems}.
   */
  includeNonRepositories?: boolean;
  t: TFunction;
};

/**
 * Ranks one folder row against the picker's search box. `0` hides the row.
 *
 * Replaces cmdk's default filter, which is a *subsequence* match: it accepts an
 * item whenever the query's characters appear in order anywhere in its value.
 * That is reasonable for short command names and wrong for filesystem paths,
 * where nearly everything matches — typing "mind" surfaced `datapoint`,
 * `audio-processing-library` and four `.cache/omni-harness/…/repo` clones,
 * because `omni-harness…d` spells m-i-n-d in order (#344). Folders are picked by
 * name, so a substring is both stricter and closer to what someone means.
 *
 * Scores are ordered, not absolute: exact name, then name prefix, then name
 * substring, then path substring. A row that matches only deep in its path is
 * still reachable but never outranks one whose name matches.
 *
 * Every row is scored the same way, including the "New project…" escape hatch:
 * a query matching nothing is meant to leave the list empty and show the
 * "No folders found" message (#338), not one lone action.
 */
export function scoreFolderMatch(label: string, path: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return 1;
  }

  const name = label.toLowerCase();
  if (name === needle) {
    return 1;
  }
  if (name.startsWith(needle)) {
    return 0.9;
  }
  if (name.includes(needle)) {
    return 0.8;
  }
  return path.toLowerCase().includes(needle) ? 0.5 : 0;
}

export type NewConversationMenu = {
  items: ActionMenuItem[];
  /**
   * How many spaces the repository filter holds back, regardless of whether
   * `includeNonRepositories` is currently on — it labels the "show all" escape
   * hatch, which has to stay stable while that toggle flips.
   */
  hiddenProjectCount: number;
};

/**
 * True when any directory in the path is hidden (dot-prefixed).
 *
 * A checkout under `~/.cache`, `~/.gemini` or the like is a tool's private
 * working copy — omni-harness alone left seven clones there — and nobody starts
 * a conversation in one. Git cannot tell them apart from a real project (they
 * are ordinary clones), but their location can. Only *directory* segments count,
 * so `~/repos/mind.integration` and `~/repos/v1.2.3-release` stay listed; the
 * leading `/` and the final segment are ignored for the same reason.
 */
function livesUnderHiddenDirectory(fullPath: string): boolean {
  return fullPath
    .split('/')
    .slice(0, -1)
    .some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

/**
 * A space is listable when the server called it a repository root, did not call
 * it a linked worktree, and it does not live inside a hidden directory.
 *
 * `undefined` on either flag is "the server never told us" (a build older than
 * that flag), not "no" — so an older payload that reports `isRepository` alone
 * still lists its repositories rather than hiding every one of them as a
 * suspected worktree. See {@link buildNewConversationItems}.
 */
function isListableRepository(project: Project): boolean {
  return (
    project.isRepository === true
    && project.isWorktree !== true
    && !livesUnderHiddenDirectory(project.fullPath ?? '')
  );
}

/**
 * Builds the "New conversation" picker menu for project-agnostic surfaces — the
 * Conversations view and the mobile landing page (#331).
 *
 * Such a surface is project-agnostic (it often has no selected project),
 * so a new conversation must first be pointed at a folder. We list the existing
 * projects in a stable, scannable order — starred first, then alphabetically by
 * name (via {@link sortProjects} with `'name'`) so the menu reads predictably
 * regardless of the Projects tab's current sort setting — and append a
 * "New project…" escape hatch so a brand-new folder can be added when the target
 * isn't a project yet. Picking a project launches the chat composer there.
 *
 * The escape hatch is appended only when a handler for it is supplied, since a
 * caller without a create-project flow would otherwise render an item that does
 * nothing (#331).
 *
 * Only repository *clones* are listed by default (#332, #344). A space row
 * exists for every session's cwd, so agents run inside `<repo>/tools/x`,
 * scratchpad dirs and long-deleted worktrees all become spaces — on a working
 * machine that is hundreds of subfolders drowning the few dozen repos anyone
 * actually starts a conversation in, and typing into the search box matched them
 * just as happily. This is the same filter the folder picker got in #309/#312,
 * applied to the other place a folder gets chosen, and it comes with the same
 * escape hatch: `includeNonRepositories` reveals the rest, counted by
 * `hiddenProjectCount`.
 *
 * Filtering on `isRepository` alone was not enough (#344): a linked worktree is
 * a repository root, and a machine running parallel agents accumulates far more
 * of those than it has repositories — 21 of 46 listed spaces on the reporter's.
 * They are hidden by default and revealed by the same toggle, rather than
 * dropped, since a worktree is a legitimate place to hold a conversation. The
 * same goes for clones under a hidden directory (see
 * {@link livesUnderHiddenDirectory}), which no git-shaped rule can catch.
 *
 * If *no* project carries the flag the payload predates it, and filtering on a
 * bit nobody set would empty the picker; in that case every space is listed and
 * nothing is reported as hidden.
 */
export function buildNewConversationItems({
  projects,
  onPickProject,
  onCreateProject,
  includeNonRepositories = false,
  t,
}: BuildNewConversationItemsArgs): NewConversationMenu {
  const serverReportsRepositories = projects.some(
    (project) => typeof project.isRepository === 'boolean',
  );
  const hiddenProjectCount = serverReportsRepositories
    ? projects.filter((project) => !isListableRepository(project)).length
    : 0;

  const listable =
    serverReportsRepositories && !includeNonRepositories
      ? projects.filter(isListableRepository)
      : projects;
  const ordered = sortProjects(listable, 'name');

  const items: ActionMenuItem[] = ordered.map((project) => ({
    key: `project:${project.projectId}`,
    label: project.displayName || project.projectId,
    description: project.fullPath,
    icon: Folder,
    onSelect: () => onPickProject(project),
  }));

  if (onCreateProject) {
    items.push({
      key: 'new-project',
      label: t('conversations.newConversationNewProject', 'New project…'),
      icon: FolderPlus,
      onSelect: onCreateProject,
      // Only divide when there are projects above it; otherwise it's the sole item.
      showDividerBefore: items.length > 0,
    });
  }

  return { items, hiddenProjectCount };
}
