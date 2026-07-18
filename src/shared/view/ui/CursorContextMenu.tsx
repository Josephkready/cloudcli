import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import { cn } from '../../../lib/utils';

import type { ActionMenuItem } from './ActionMenu';

const CONTEXT_MENU_WIDTH = 220;
const CONTEXT_MENU_HEIGHT = 300;
const VIEWPORT_PADDING = 10;

function calculateViewportSafePosition(clientX: number, clientY: number) {
  // Keep the context menu inside the visible viewport.
  const safeX =
    clientX + CONTEXT_MENU_WIDTH > window.innerWidth
      ? window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_PADDING
      : clientX;
  const safeY =
    clientY + CONTEXT_MENU_HEIGHT > window.innerHeight
      ? window.innerHeight - CONTEXT_MENU_HEIGHT - VIEWPORT_PADDING
      : clientY;

  return { x: Math.max(VIEWPORT_PADDING, safeX), y: Math.max(VIEWPORT_PADDING, safeY) };
}

/**
 * Reusable right-click context menu positioned at the cursor. Wraps `children`
 * and opens a menu of `items` on contextmenu, closing on outside-click, Escape,
 * or selection. Modeled on the file-tree FileContextMenu chrome, but generic over
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
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  const closeContextMenu = useCallback(() => {
    setIsMenuOpen(false);
  }, []);

  const openContextMenuAtCursor = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (disabled || items.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      setMenuPosition(calculateViewportSafePosition(event.clientX, event.clientY));
      setIsMenuOpen(true);
    },
    [disabled, items.length],
  );

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

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handleOutsideMouseDown = (event: MouseEvent) => {
      const menuElement = menuRef.current;
      if (menuElement && !menuElement.contains(event.target as Node)) {
        closeContextMenu();
      }
    };

    const handleEscapeKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleEscapeKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleEscapeKeyDown);
    };
  }, [closeContextMenu, isMenuOpen]);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    // Arrow key support keeps the menu accessible without a mouse.
    const handleKeyboardMenuNavigation = (event: KeyboardEvent) => {
      const menuItems = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])');
      if (!menuItems || menuItems.length === 0) {
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const currentIndex = Array.from(menuItems).findIndex((menuItem) => menuItem === activeElement);

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const nextIndex = currentIndex < menuItems.length - 1 ? currentIndex + 1 : 0;
        menuItems[nextIndex]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const previousIndex = currentIndex > 0 ? currentIndex - 1 : menuItems.length - 1;
        menuItems[previousIndex]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        if (activeElement?.hasAttribute('role')) {
          event.preventDefault();
          activeElement.click();
        }
      }
    };

    document.addEventListener('keydown', handleKeyboardMenuNavigation);

    return () => {
      document.removeEventListener('keydown', handleKeyboardMenuNavigation);
    };
  }, [isMenuOpen]);

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
                  {Icon && <Icon className="h-4 w-4 flex-shrink-0" />}
                  <span className="flex-1">{item.label}</span>
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </>
  );
}
