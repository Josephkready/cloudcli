import { Archive, ExternalLink, Pencil, Trash2 } from 'lucide-react';

import type { ActionMenuItem } from '../../../shared/view/ui';

export type SessionContextMenuLabels = {
  openInNewTab: string;
  rename: string;
  archive: string;
  delete: string;
};

export type SessionContextMenuHandlers = {
  onOpenInNewTab: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
};

/**
 * Build the right-click context-menu action list for a session row, shared by the
 * Projects view (SidebarSessionItem) and the Conversations view (ConversationRow)
 * so both rows expose the same menu.
 *
 * Open-in-new-tab and Rename are always offered. The destructive actions (Archive
 * and permanent Delete) are omitted while a run is live — mirroring the hover
 * cluster, which hides its archive/delete button on `isActive` so an in-flight
 * session can't be torn down from the row.
 */
export function buildSessionContextMenuActions(params: {
  isActive: boolean;
  labels: SessionContextMenuLabels;
  handlers: SessionContextMenuHandlers;
}): ActionMenuItem[] {
  const { isActive, labels, handlers } = params;

  const actions: ActionMenuItem[] = [
    {
      key: 'open-in-new-tab',
      label: labels.openInNewTab,
      icon: ExternalLink,
      onSelect: handlers.onOpenInNewTab,
    },
    {
      key: 'rename',
      label: labels.rename,
      icon: Pencil,
      onSelect: handlers.onRename,
    },
  ];

  if (!isActive) {
    actions.push(
      {
        key: 'archive',
        label: labels.archive,
        icon: Archive,
        onSelect: handlers.onArchive,
        showDividerBefore: true,
      },
      {
        key: 'delete',
        label: labels.delete,
        icon: Trash2,
        onSelect: handlers.onDelete,
        isDanger: true,
      },
    );
  }

  return actions;
}
