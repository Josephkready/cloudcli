import { useCallback, useEffect, useRef } from 'react';

/**
 * The one ordered stack of live overlays, shared by `useOverlayDismiss` (#243)
 * and `useFocusTrap` (#274).
 *
 * Both hooks need the same answer to "am I the dialog the user is looking at?":
 * with the folder picker open on top of the project wizard, Esc must close only
 * the picker *and* Tab must cycle only inside the picker. Two independent
 * stacks could drift out of agreement — one thinking the picker is on top while
 * the other still favours the wizard — so registration order lives here once.
 *
 * Registration order == visual stacking order: an overlay rendered by another
 * overlay's subtree always mounts (and therefore registers) after its parent.
 *
 * A layer declares which `concern` it registered for, and topmost-ness is
 * resolved per concern. That matters because one overlay registers twice (once
 * per hook): without the concern filter, the picker's focus layer sitting above
 * the picker's dismiss layer would convince the dismiss hook it was not on top,
 * and Esc would stop working entirely. The *ordering* they compare against is
 * still the single array below, which is the part that must never disagree.
 */

export type OverlayConcern = 'dismiss' | 'focus';

type OverlayLayer = { concern: OverlayConcern };

const overlayLayers: OverlayLayer[] = [];

/** Topmost among the layers registered for the same concern. */
function isTopmostLayer(layer: OverlayLayer): boolean {
  for (let index = overlayLayers.length - 1; index >= 0; index -= 1) {
    const candidate = overlayLayers[index];
    if (candidate.concern === layer.concern) {
      return candidate === layer;
    }
  }
  return false;
}

/**
 * Claim a slot in the overlay stack while `isActive`, and report whether this
 * overlay is currently the topmost one for its concern.
 */
export function useOverlayLayer({
  concern,
  isActive,
}: {
  concern: OverlayConcern;
  isActive: boolean;
}) {
  const layerRef = useRef<OverlayLayer>({ concern });

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const layer = layerRef.current;
    overlayLayers.push(layer);

    return () => {
      const index = overlayLayers.indexOf(layer);
      if (index !== -1) {
        overlayLayers.splice(index, 1);
      }
    };
  }, [isActive]);

  // Stable identity so consumers can list it as an effect dependency without
  // re-subscribing their document listeners on every render.
  const isTopmost = useCallback(() => isTopmostLayer(layerRef.current), []);

  return { isTopmost };
}
