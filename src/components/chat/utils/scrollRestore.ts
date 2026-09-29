/**
 * How the viewport should be placed after older messages are prepended.
 *
 * Prepending shifts every rendered message down by the height of whatever
 * arrived above it, so the pre-load `scrollTop` no longer points at the same
 * content. Both intents below need the pre-load measurements to compute the
 * correct landing offset; they differ only in where the user asked to end up.
 */
export type ScrollRestoreMode =
  /** Incremental load-more: hold the reader's place across the prepend. */
  | 'preserve'
  /** Explicit "Load all messages": land at the beginning of the thread. */
  | 'toStart';

export interface ScrollRestoreState {
  mode: ScrollRestoreMode;
  /** `scrollTop` sampled immediately before the prepend. */
  top: number;
  /** `scrollHeight` sampled immediately before the prepend. */
  height: number;
}

/**
 * Resolves the `scrollTop` to apply once the prepended messages have been laid
 * out. Pure so the offset arithmetic is testable without a DOM.
 *
 * Kept as the fallback path for `resolveScrollRestoreTop` below (cloudcli
 * B1): a raw `scrollHeight`/`scrollTop` delta assumes every row already has
 * its final measured height at restore time, which a virtualized list only
 * guarantees for rows that have actually mounted and measured. When an
 * anchor row can be found, prefer `resolveAnchoredScrollTop` instead.
 */
export function resolveRestoreScrollTop(
  state: ScrollRestoreState,
  newScrollHeight: number,
): number {
  if (state.mode === 'toStart') {
    return 0;
  }

  // Clamped at 0 so a container that shrank never yanks the user upward.
  return state.top + Math.max(newScrollHeight - state.height, 0);
}

/**
 * Identifies a specific rendered row (by its stable, prepend-invariant
 * `data-row-key`) and how far below the scroll container's own top edge that
 * row sat at capture time.
 */
export interface ScrollAnchor {
  key: string;
  offset: number;
}

/**
 * Resolves the `scrollTop` to apply so that `anchor`'s row lands back at the
 * same offset below the container's top edge, given where that row's top
 * edge sits *right now* (post-prepend, post-layout).
 *
 * Pure delta arithmetic against real, currently-measured positions — unlike
 * `resolveRestoreScrollTop`, it never depends on `scrollHeight` (which lags
 * behind virtualized rows that haven't measured yet) or on the pre-fetch
 * `scrollTop` (which the reader may have kept moving while the fetch was in
 * flight). `currentScrollTop` and `anchorElementTop` should both be read at
 * the moment of restoring, not at capture time.
 */
export function resolveAnchoredScrollTop(params: {
  /** The container's `scrollTop` right now, before this correction. */
  currentScrollTop: number;
  /** The anchor row's `getBoundingClientRect().top`, relative to the
   *  container's own top edge, read right now. */
  anchorElementTop: number;
  /** The anchor captured before the prepend. */
  anchor: ScrollAnchor;
  /** `scrollHeight - clientHeight`; clamps the result so it never overshoots. */
  maxScrollTop: number;
}): number {
  const target = params.currentScrollTop + (params.anchorElementTop - params.anchor.offset);
  return Math.max(0, Math.min(target, Math.max(params.maxScrollTop, 0)));
}
