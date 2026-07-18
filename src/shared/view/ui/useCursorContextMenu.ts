import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

const DEFAULT_CONTEXT_MENU_WIDTH = 220;
const DEFAULT_CONTEXT_MENU_HEIGHT = 300;
const VIEWPORT_PADDING = 10;

/**
 * Clamp a cursor position so a menu of the given size stays inside the visible
 * viewport, flipping away from the right/bottom edges and never overlapping the
 * padding gutter. Pure — safe to unit test without a DOM by stubbing `window`.
 */
export function calculateViewportSafePosition(
  clientX: number,
  clientY: number,
  menuWidth: number = DEFAULT_CONTEXT_MENU_WIDTH,
  menuHeight: number = DEFAULT_CONTEXT_MENU_HEIGHT,
  padding: number = VIEWPORT_PADDING,
) {
  const safeX =
    clientX + menuWidth > window.innerWidth ? window.innerWidth - menuWidth - padding : clientX;
  const safeY =
    clientY + menuHeight > window.innerHeight ? window.innerHeight - menuHeight - padding : clientY;

  return { x: Math.max(padding, safeX), y: Math.max(padding, safeY) };
}

/**
 * Whether an Enter/Space keypress should activate `activeElement`. True only for
 * a `role="menuitem"` that lives inside the open menu — never some other
 * role-bearing element that happened to hold focus when the menu opened. This is
 * the scoping that keeps keyboard activation from `.click()`-ing arbitrary
 * elements in the document. Pure predicate — unit-testable with element stubs.
 */
export function isActivatableMenuTarget(
  activeElement: Element | null,
  menuElement: Element | null,
): boolean {
  return Boolean(
    activeElement &&
      menuElement?.contains(activeElement) &&
      activeElement.getAttribute('role') === 'menuitem',
  );
}

type UseCursorContextMenuOptions = {
  /**
   * When true, right-click is ignored and the native browser menu is left
   * intact (e.g. an empty action list, or a link keeping "Open in new tab").
   */
  disabled?: boolean;
  /** Menu width used for viewport-safe horizontal positioning. */
  menuWidth?: number;
};

/**
 * Shared chrome for a cursor-positioned right-click menu: open/close state,
 * viewport-safe positioning, outside-click + Escape dismissal, and arrow-key
 * roving focus with scoped Enter/Space activation. Consumed by both
 * `CursorContextMenu` and the file-tree `FileContextMenu` so the two can't
 * drift. Callers own the rendered menu markup; this owns the behavior.
 */
export function useCursorContextMenu({ disabled = false, menuWidth }: UseCursorContextMenuOptions = {}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  const closeContextMenu = useCallback(() => {
    setIsMenuOpen(false);
  }, []);

  const openContextMenuAtCursor = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (disabled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      setMenuPosition(calculateViewportSafePosition(event.clientX, event.clientY, menuWidth));
      setIsMenuOpen(true);
    },
    [disabled, menuWidth],
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
        if (isActivatableMenuTarget(activeElement, menuRef.current)) {
          event.preventDefault();
          activeElement?.click();
        }
      }
    };

    document.addEventListener('keydown', handleKeyboardMenuNavigation);

    return () => {
      document.removeEventListener('keydown', handleKeyboardMenuNavigation);
    };
  }, [isMenuOpen]);

  return { isMenuOpen, menuPosition, menuRef, openContextMenuAtCursor, closeContextMenu };
}
