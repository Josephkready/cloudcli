/**
 * Mount policy for a tab whose surface is expensive to build (issue #272).
 *
 * Most tabs are cheap enough to unmount when you leave them. The shell is not:
 * every mount pays `new Terminal()`, four addon loads, a WebGL context and a
 * fresh pty websocket, so unmounting on tab-away makes *every* return cost as
 * much as the first open.
 *
 * The policy is "sticky, but scoped": once the surface has been opened it stays
 * mounted (hidden) for as long as the scope key holds, and it is dropped the
 * moment the key changes — so a background surface can never outlive the thing
 * it belongs to, and at most one is ever alive.
 */

export type StickyMountState = {
  /** Scope the mount belongs to (the selected project, for the shell). */
  key: string | null;
  /** Whether the surface has been opened at least once within that scope. */
  mounted: boolean;
};

export function initialStickyMountState(isActive: boolean, key: string | null): StickyMountState {
  return { key, mounted: isActive };
}

/**
 * Returns the next state, or `previous` itself when nothing changed so callers
 * can skip a re-render.
 */
export function nextStickyMountState(
  previous: StickyMountState,
  isActive: boolean,
  key: string | null,
): StickyMountState {
  if (previous.key !== key) {
    return { key, mounted: isActive };
  }

  if (isActive && !previous.mounted) {
    return { key, mounted: true };
  }

  return previous;
}

/**
 * Whether the surface should be in the tree for this render.
 *
 * `isActive` is honoured immediately rather than waiting for the state commit,
 * so the first open still renders in the same pass as the click.
 */
export function shouldRenderSticky(
  state: StickyMountState,
  isActive: boolean,
  key: string | null,
): boolean {
  return isActive || (state.key === key && state.mounted);
}
