import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { Project } from '../../../../types/app';
import { Button } from '../../../../shared/view/ui';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../../../../shared/view/ui/Command';
import { cn } from '../../../../lib/utils';
import { buildNewConversationItems } from '../../utils/newConversation';

type SidebarNewConversationButtonProps = {
  projects: Project[];
  // Launches the chat composer for a chosen project (wired to handleNewSession).
  onNewConversation: (project: Project) => void;
  // Opens the create-project flow for when the target folder isn't a project yet.
  // Optional: that flow is the sidebar's own state, so surfaces outside it (the
  // mobile landing page, #331) drop the item instead of showing a dead control.
  onCreateProject?: () => void;
  className?: string;
  t: TFunction;
};

/**
 * "New conversation" action for project-agnostic surfaces — the sidebar's
 * Conversations view and the mobile landing page (#331). Neither has an inherent
 * project, so the button opens a searchable, scrollable picker of existing
 * projects (plus a "New project…" escape hatch where the caller has that flow);
 * selecting one launches a fresh chat there.
 *
 * Built on the cmdk `Command` primitives (issue #186) rather than the old
 * `ActionMenu`, which had no filter input and no scroll container — so a long
 * folder list is now type-to-filter instead of an unbounded scroll.
 */
export default function SidebarNewConversationButton({
  projects,
  onNewConversation,
  onCreateProject,
  className,
  t,
}: SidebarNewConversationButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const items = buildNewConversationItems({
    projects,
    onPickProject: onNewConversation,
    onCreateProject,
    t,
  });

  const label = t('conversations.newConversation', 'New conversation');

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <Button
        variant="outline"
        size="sm"
        aria-label={label}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="w-full justify-center gap-1.5"
      >
        <MessageSquarePlus className="h-4 w-4" />
        {label}
      </Button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          <Command>
            <CommandInput
              autoFocus
              placeholder={t('conversations.newConversationSearchPlaceholder', 'Search folders…')}
            />
            <CommandList>
              <CommandEmpty>{t('conversations.newConversationNoResults', 'No folders found')}</CommandEmpty>
              <CommandGroup>
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.key}>
                      {item.showDividerBefore && <CommandSeparator />}
                      <CommandItem
                        value={`${item.label} ${item.description ?? ''} ${item.key}`}
                        onSelect={() => {
                          item.onSelect();
                          setIsOpen(false);
                        }}
                      >
                        {Icon && <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{item.label}</div>
                          {item.description && (
                            <div className="truncate text-xs text-muted-foreground">{item.description}</div>
                          )}
                        </div>
                      </CommandItem>
                    </div>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
