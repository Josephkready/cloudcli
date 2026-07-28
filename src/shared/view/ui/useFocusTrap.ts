import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { useOverlayLayer } from './overlayLayers';

/**
 * Keyboard focus containment for a modal overlay: Tab and Shift+Tab cycle
 * inside the dialog, and closing it hands focus back to whatever opened it.
 *
 * #243 gave the hand-rolled `fixed inset-0` overlays Esc/backdrop dismissal via
 * `useOverlayDismiss`, but deliberately left focus alone — so Tab still walked
 * out of the dialog and into the page underneath, where a keyboard or
 * screen-reader user could operate controls hidden behind the modal (#274).
 * This is the other half of that pair, and it shares the same overlay stack, so
 * with two dialogs open the trap follows the same overlay Esc closes.
 *
 * Attach the returned `containerRef` to the dialog element (not the backdrop).
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

type UseFocusTrapOptions = {
  /** Whether the overlay is currently open. */
  isActive: boolean;
  /**
   * Where focus should land when the overlay opens. Mobile pickers can focus
   * the container to avoid summoning the software keyboard before the user
   * explicitly chooses to search.
   */
  initialFocus?: 'first' | 'container';
  /**
   * Preferred element to focus on close (a dialog trigger, typically). Falls
   * back to whatever had focus when the overlay opened.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
};

export function useFocusTrap<T extends HTMLElement = HTMLElement>({
  isActive,
  initialFocus = 'first',
  restoreFocusRef,
}: UseFocusTrapOptions) {
  const containerRef = useRef<T | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const { isTopmost } = useOverlayLayer({ concern: 'focus', isActive });

  // Read the restore target lazily at close time: a trigger ref is usually null
  // on the render that opens the dialog.
  const restoreFocusRefRef = useRef(restoreFocusRef);
  restoreFocusRefRef.current = restoreFocusRef;

  // A dialog can legitimately hold nothing focusable — the project wizard
  // disables its close button and both footer buttons while a create is in
  // flight. Focusing the container itself keeps an anchor inside the dialog
  // (WAI-ARIA APG) instead of parking focus on <body>, which would strand a
  // keyboard user in exactly the window where Esc is disabled too.
  const focusFirst = useCallback((container: T) => {
    const [first] = getFocusable(container);
    if (first) {
      first.focus();
      return;
    }
    if (!container.hasAttribute('tabindex')) {
      container.tabIndex = -1;
    }
    container.focus();
  }, []);

  const focusContainer = useCallback((container: T) => {
    if (!container.hasAttribute('tabindex')) {
      container.tabIndex = -1;
    }
    container.focus();
  }, []);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    previousFocusRef.current = document.activeElement as HTMLElement | null;

    // Pull focus in unless the dialog already claimed it itself (an `autoFocus`
    // field, say) — otherwise focus would still be sitting on the trigger
    // behind the overlay and the very first Tab would leave.
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) {
      if (initialFocus === 'container') {
        focusContainer(container);
      } else {
        focusFirst(container);
      }
    }

    return () => {
      const restoreTarget = restoreFocusRefRef.current?.current ?? previousFocusRef.current;
      previousFocusRef.current = null;

      // This cleanup also runs when the dialog is unmounted while still open (a
      // settings tab switch, a route change). Only reclaim focus if this dialog
      // still owns it — or if nothing does, which is where an unmount leaves it.
      // Otherwise we would steal focus from wherever the user actually moved.
      const active = document.activeElement as HTMLElement | null;
      const ownsFocus =
        !active || active === document.body || (container?.contains(active) ?? false);
      if (!ownsFocus) {
        return;
      }

      // A closing dialog often takes its opener with it (a whole page swap, a
      // list row that re-rendered); focusing a detached node just blanks focus.
      if (restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus();
      }
    };
  }, [focusContainer, focusFirst, initialFocus, isActive]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') {
        return;
      }

      const container = containerRef.current;
      // Only the topmost overlay traps, so a picker stacked on the wizard owns
      // Tab exactly as it owns Esc.
      if (!container || !isTopmost()) {
        return;
      }

      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        // Nothing to move to, but letting Tab through would leave the dialog.
        // Anchor on the container so focus stays addressable rather than
        // falling to <body> with no way back in.
        event.preventDefault();
        focusFirst(container);
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (active === container) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (!active || !container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture phase so the trap wins before a control's own Tab handling.
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [focusFirst, isActive, isTopmost]);

  return { containerRef };
}
