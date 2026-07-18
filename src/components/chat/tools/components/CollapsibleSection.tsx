import React from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';

interface CollapsibleSectionProps {
  title: string;
  toolName?: string;
  open?: boolean;
  action?: React.ReactNode;
  badge?: React.ReactNode;
  onTitleClick?: () => void;
  children: React.ReactNode;
  className?: string;
  /** Cap the expanded body's height and scroll past it (default true). Set
   *  false for interactive content (e.g. question/answer prompts) the user
   *  should see in full without an inner scrollbar. */
  capHeight?: boolean;
}

/**
 * Reusable collapsible section with consistent styling
 */
export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  toolName,
  open = false,
  action,
  badge,
  onTitleClick,
  children,
  className = '',
  capHeight = true,
}) => {
  return (
    <Collapsible defaultOpen={open} className={cn('group/section', className)}>
      {/* When there's a clickable title (Edit/Write), only the chevron toggles collapse */}
      {onTitleClick ? (
        <div className="flex cursor-default select-none items-center gap-1.5 py-0.5 text-xs group-data-[state=open]/section:sticky group-data-[state=open]/section:top-0 group-data-[state=open]/section:z-10 group-data-[state=open]/section:-mx-1 group-data-[state=open]/section:bg-background group-data-[state=open]/section:px-1">
          <CollapsibleTrigger className="flex flex-shrink-0 items-center p-0.5 text-muted-foreground hover:text-foreground">
            <svg
              className="h-3 w-3 transition-transform duration-150 group-data-[state=open]/section:rotate-90"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </CollapsibleTrigger>
          {toolName && (
            <span className="flex-shrink-0 font-medium text-muted-foreground">{toolName}</span>
          )}
          {toolName && (
            <span className="flex-shrink-0 text-[10px] text-muted-foreground/40">/</span>
          )}
          <button
            onClick={onTitleClick}
            className="flex-1 truncate text-left font-mono text-primary transition-colors hover:text-primary/80 hover:underline"
          >
            {title}
          </button>
          {badge && <span className="ml-auto flex-shrink-0">{badge}</span>}
          {action && <span className="ml-1 flex-shrink-0">{action}</span>}
        </div>
      ) : (
        <CollapsibleTrigger className="flex w-full select-none items-center gap-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground group-data-[state=open]/section:sticky group-data-[state=open]/section:top-0 group-data-[state=open]/section:z-10 group-data-[state=open]/section:-mx-1 group-data-[state=open]/section:bg-background group-data-[state=open]/section:px-1">
          <svg
            className="h-3 w-3 flex-shrink-0 transition-transform duration-150 group-data-[state=open]/section:rotate-90"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          {toolName && (
            <span className="flex-shrink-0 font-medium">{toolName}</span>
          )}
          {toolName && (
            <span className="flex-shrink-0 text-[10px] text-muted-foreground/40">/</span>
          )}
          <span className="flex-1 truncate text-left">{title}</span>
          {badge && <span className="ml-auto flex-shrink-0">{badge}</span>}
          {action && <span className="ml-1 flex-shrink-0">{action}</span>}
        </CollapsibleTrigger>
      )}

      <CollapsibleContent>
        {/* Cap expanded tool output so a large result can't dominate the chat
            (#58). Renderers with their own tighter cap (TextContent max-h-80,
            Bash max-h-80) scroll first, so this outer bound only binds for
            otherwise-uncapped children. */}
        <div className={cn('mt-1.5 pl-[18px]', capHeight && 'max-h-[32rem] overflow-y-auto')}>
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
