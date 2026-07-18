import { MessageSquarePlus } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { Project } from '../../../../types/app';
import ActionMenu from '../../../../shared/view/ui/ActionMenu';
import { buildNewConversationItems } from '../../utils/newConversation';

type SidebarNewConversationButtonProps = {
  projects: Project[];
  // Launches the chat composer for a chosen project (wired to handleNewSession).
  onNewConversation: (project: Project) => void;
  // Opens the create-project flow for when the target folder isn't a project yet.
  onCreateProject: () => void;
  className?: string;
  t: TFunction;
};

/**
 * "New conversation" action for the Conversations view. Since that view has no
 * inherent project, the button opens a picker of existing projects (plus a
 * "New project…" escape hatch); selecting one launches a fresh chat there.
 */
export default function SidebarNewConversationButton({
  projects,
  onNewConversation,
  onCreateProject,
  className,
  t,
}: SidebarNewConversationButtonProps) {
  const items = buildNewConversationItems({
    projects,
    onPickProject: onNewConversation,
    onCreateProject,
    t,
  });

  const label = t('conversations.newConversation', 'New conversation');

  return (
    <ActionMenu
      label={label}
      ariaLabel={label}
      items={items}
      icon={MessageSquarePlus}
      align="left"
      variant="outline"
      size="sm"
      className={className}
    />
  );
}
