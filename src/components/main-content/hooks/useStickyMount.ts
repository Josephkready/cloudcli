import { useEffect, useState } from 'react';

import {
  initialStickyMountState,
  nextStickyMountState,
  shouldRenderSticky,
  type StickyMountState,
} from './stickyMount.pure';

/**
 * Keeps an expensive surface mounted after its first open, scoped to `key`
 * (issue #272).
 *
 * Returns true while the surface should be rendered. Callers are expected to
 * *hide* it (`display: none`) rather than unmount it when it is not the active
 * tab — see `stickyMount.pure.ts` for why the shell needs this and why the
 * scope key matters.
 */
export function useStickyMount(isActive: boolean, key: string | null): boolean {
  const [state, setState] = useState<StickyMountState>(() => initialStickyMountState(isActive, key));

  useEffect(() => {
    setState((previous) => nextStickyMountState(previous, isActive, key));
  }, [isActive, key]);

  return shouldRenderSticky(state, isActive, key);
}
