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
 * A space counts as a repository root when the server said so. `undefined` is
 * "the server never told us" (a build older than the flag), not "no" — see
 * {@link buildNewConversationItems} for why that distinction matters.
 */
function isRepositoryRoot(project: Project): boolean {
  return project.isRepository === true;
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
 * Only repository roots are listed by default (#332). A space row exists for
 * every session's cwd, so agents run inside `<repo>/tools/x`, scratchpad dirs
 * and long-deleted worktrees all become spaces — on a working machine that is
 * hundreds of subfolders drowning the few dozen repos anyone actually starts a
 * conversation in, and typing into the search box matched them just as happily.
 * This is the same filter the folder picker got in #309/#312, applied to the
 * other place a folder gets chosen, and it comes with the same escape hatch:
 * `includeNonRepositories` reveals the rest, counted by `hiddenProjectCount`.
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
    ? projects.filter((project) => !isRepositoryRoot(project)).length
    : 0;

  const listable =
    serverReportsRepositories && !includeNonRepositories
      ? projects.filter(isRepositoryRoot)
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
