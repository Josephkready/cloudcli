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
