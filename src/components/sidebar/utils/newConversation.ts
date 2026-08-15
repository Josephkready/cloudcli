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
  t: TFunction;
};

/**
 * Builds the "New conversation" picker menu for the Conversations view.
 *
 * The Conversations view is project-agnostic (it often has no selected project),
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
 */
export function buildNewConversationItems({
  projects,
  onPickProject,
  onCreateProject,
  t,
}: BuildNewConversationItemsArgs): ActionMenuItem[] {
  const ordered = sortProjects(projects, 'name');

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

  return items;
}
