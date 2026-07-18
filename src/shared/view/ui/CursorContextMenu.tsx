import { Fragment, useCallback, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '../../../lib/utils';

import type { ActionMenuItem } from './ActionMenu';
import { useCursorContextMenu } from './useCursorContextMenu';

/**
 * Reusable right-click context menu positioned at the cursor. Wraps `children`
 * and opens a menu of `items` on contextmenu, closing on outside-click, Escape,
 * or selection. Shares its chrome (positioning, dismissal, keyboard nav) with
 * the file-tree FileContextMenu via `useCursorContextMenu`, but is generic over
 * the shared ActionMenuItem shape so any surface can supply its own actions.
 *
 * When `disabled` or `items` is empty the native browser menu is left intact
 * (e.g. so a link keeps its "Open in new tab" affordance).
 */
export default function CursorContextMenu({
  children,
  items,
  ariaLabel,
  disabled = false,
  className,
}: {
  children: ReactNode;
  items: ActionMenuItem[];
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const { isMenuOpen, menuPosition, menuRef, openContextMenuAtCursor, closeContextMenu } =
    useCursorContextMenu({ disabled: disabled || items.length === 0 });

  const runItemAndClose = useCallback(
    (item: ActionMenuItem) => {
      if (item.disabled || item.loading) {
        return;
      }
      closeContextMenu();
      item.onSelect();
    },
    [closeContextMenu],
  );

  return (
    <>
      <div onContextMenu={openContextMenuAtCursor} className={cn('contents', className)}>
        {children}
      </div>

      {isMenuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={ariaLabel}
          style={{ position: 'fixed', left: menuPosition.x, top: menuPosition.y, zIndex: 9999 }}
          className={cn(
            'min-w-[200px] px-1 py-1',
            'rounded-lg border border-border bg-popover text-popover-foreground shadow-lg',
            'animate-in fade-in-0 zoom-in-95',
          )}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Fragment key={item.key}>
                {item.showDividerBefore && <div className="mx-2 my-1 h-px bg-border" />}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={item.disabled ? -1 : 0}
                  disabled={item.disabled || item.loading}
                  onClick={() => runItemAndClose(item)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                    'focus:bg-accent focus:outline-none',
                    item.disabled || item.loading
                      ? 'cursor-not-allowed opacity-50'
                      : item.isDanger
                        ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950'
                        : 'hover:bg-accent',
                  )}
                >
                  {item.loading ? (
                    <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
                  ) : (
                    Icon && <Icon className="h-4 w-4 flex-shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block">{item.label}</span>
                    {item.description && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">{item.description}</span>
                    )}
                  </span>
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </>
  );
}
