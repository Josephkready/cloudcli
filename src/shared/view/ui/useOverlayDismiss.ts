import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { useOverlayLayer } from './overlayLayers';

/**
 * Esc-to-close + backdrop-to-close for hand-rolled `fixed inset-0` overlays.
 *
 * The shared `Dialog` primitive already does this, but a few dialogs are
 * hand-rolled overlays whose layout (full-bleed on mobile, custom widths,
 * portalled z-indexes) does not fit `DialogContent`. Rather than copy the same
 * two handlers into each of them — and get the stacking subtly wrong — they
 * opt in here (#243). Pair it with `useFocusTrap` (#274) for the focus half.
 *
 * **Stacking.** The folder picker renders *inside* the project-creation wizard,
 * so both are mounted at once and a document-level `keydown` would otherwise
 * close both with a single Esc. Active overlays register in the shared stack in
 * `overlayLayers.ts` and only the topmost one reacts, which matches how a user
 * reads a stack of dialogs: Esc peels off one layer.
 */

type UseOverlayDismissOptions = {
  /**
   * Whether this overlay should currently respond. Pass `false` while the
   * overlay is closed, or while a nested affordance owns Esc itself (the
   * picker's inline "new folder" field does this, so the first Esc cancels the
   * field and a second closes the picker).
   */
  isActive: boolean;
  onDismiss: () => void;
};

export function useOverlayDismiss({ isActive, onDismiss }: UseOverlayDismissOptions) {
  // Keep the latest callback without re-registering the overlay (which would
  // reorder the stack) every time the parent re-renders.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const { isTopmost } = useOverlayLayer({ concern: 'dismiss', isActive });

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (!isTopmost()) {
        return;
      }

      // Stop here so a single Esc doesn't also reach whatever is underneath.
      event.stopPropagation();
      onDismissRef.current();
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isActive, isTopmost]);

  const handleBackdropMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    // Only a press that starts on the backdrop itself counts. Using mousedown
    // (not click) means a text selection that starts inside the dialog and
    // releases over the backdrop does not close it.
    if (event.target !== event.currentTarget) {
      return;
    }
    // Keep the press from moving focus to <body> after React unmounts the
    // dialog. The focus-trap cleanup restores the opener during this handler;
    // without preventing the native mousedown default, the browser immediately
    // overwrites that restoration as the click finishes (#279).
    event.preventDefault();
    onDismissRef.current();
  }, []);

  const backdropProps = useMemo(
    () => ({ onMouseDown: handleBackdropMouseDown }),
    [handleBackdropMouseDown],
  );

  return { backdropProps };
}
