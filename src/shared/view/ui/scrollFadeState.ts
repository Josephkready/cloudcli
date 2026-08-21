/**
 * Pure geometry for horizontal "there's more" scroll affordances.
 *
 * A horizontally scrollable row that hides its scrollbar (e.g. a `scrollbar-hide`
 * pill/tab strip) gives the user no cue that content continues past either edge.
 * The fix is an edge gradient shown only on the side that actually has more to
 * scroll — which side is a function of the element's scroll geometry alone, so it
 * lives here where it can be unit-tested without a DOM.
 */
export type ScrollFadeMetrics = {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

export type ScrollFadeState = {
  canScrollLeft: boolean;
  canScrollRight: boolean;
};

/**
 * A 2px slack on each end: sub-pixel rounding and momentum overscroll routinely
 * leave `scrollLeft` a fraction off 0 (or off the max), and without the slack the
 * fade would flicker on at rest or cling as a permanent sliver at the extremes.
 */
const EDGE_TOLERANCE = 2;

export function computeScrollFade({
  scrollLeft,
  scrollWidth,
  clientWidth,
}: ScrollFadeMetrics): ScrollFadeState {
  return {
    canScrollLeft: scrollLeft > EDGE_TOLERANCE,
    canScrollRight: scrollLeft < scrollWidth - clientWidth - EDGE_TOLERANCE,
  };
}
