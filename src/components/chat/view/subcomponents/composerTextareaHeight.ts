/**
 * Bounds the chat composer's textarea against the *visible* viewport, not
 * just its own content (cloudcli#475).
 *
 * ## The bug this replaces
 *
 * The textarea's growth cap was two static Tailwind classes —
 * `max-h-[40vh] sm:max-h-[300px]` — chosen for a comfortably tall viewport and
 * blind to two things that shrink the space actually available:
 *
 * 1. **The on-screen keyboard.** `40vh`/`300px` are measured against the
 *    *layout* viewport (`100vh`), which iOS does not shrink when the keyboard
 *    opens — only the *visual* viewport does (see `keyboardViewport.ts`, which
 *    publishes the difference as `--keyboard-height`). A composer sized against
 *    the wrong viewport can render its footer, and the send button inside it,
 *    behind the keyboard.
 * 2. **A short viewport.** `sm:max-h-[300px]` applies from 640px of *width*
 *    onward with no regard for *height* — exactly the shape of a phone rotated
 *    to landscape (844x390). A 300px-tall textarea in a 390px-tall viewport
 *    leaves no room for the header, the footer, or the send button in it: a
 *    12-line message measured pushing the send button 39px past the bottom of
 *    the viewport (cloudcli#475's second failure).
 *
 * ## The fix
 *
 * Replace the static ceiling with `min(300px, 40vh, <space actually left>)`.
 * The `space actually left` term is `100dvh` (the layout viewport — stable
 * across the keyboard opening) minus the published keyboard height minus a
 * fixed reserve for the composer's own chrome that sits above and below the
 * textarea (the chat header — including its per-project session-tabs row,
 * which only appears once a session exists — and the footer/padding below the
 * textarea within the composer itself — see
 * {@link COMPOSER_CHROME_RESERVE_PX}). Because it is a `min()` alongside the
 * original two terms, it can only ever make the cap *more* restrictive than
 * before — a tall, keyboard-free viewport still lands on the original
 * 300px/40vh ceiling, unchanged.
 *
 * `ChatMessagesPane`'s own vertical padding was moved off its scroll
 * container and onto its scrolled content for the same reason (see that
 * file): a flex item's box-sizing can never resolve smaller than its own
 * padding, so padding on the container would otherwise put a floor under how
 * far that pane could shrink — exactly the room this reserve is trying to
 * reclaim for the composer.
 *
 * When the reserve alone exceeds the visible height (the most extreme
 * landscape-plus-keyboard geometry — measured empirically with an actual
 * multi-session tabs row: 260px keyboard, 390px viewport, 93px header), the
 * formula would go negative; `max()` floors it at
 * {@link COMPOSER_TEXTAREA_MIN_HEIGHT_PX} so there is always at least a
 * sliver of visible input rather than a collapsed textarea. The textarea
 * already scrolls its own overflow (`overflow-y-auto`), so text beyond what
 * fits is never lost — just scrolled, the way it already was for the
 * un-keyboard-aware 300px cap.
 */

/**
 * Header (~48-56px with a single session, no tabs row) plus that same
 * header's per-project session-tabs row once a session exists (~40px more —
 * `MainContentSessionTabs` renders nothing for a brand-new, session-free
 * project, which is the case the *first* pass at this reserve was measured
 * against and why it undershot in a live session) plus the composer's own
 * footer row and its bottom padding (~80-88px). Rounded up for safety.
 */
export const COMPOSER_CHROME_RESERVE_PX = 184;

/** Never let the textarea collapse fully out of view, even under the most extreme keyboard/viewport squeeze. */
export const COMPOSER_TEXTAREA_MIN_HEIGHT_PX = 24;

export function computeComposerTextareaMaxHeight({
  chromeReservePx = COMPOSER_CHROME_RESERVE_PX,
  minHeightPx = COMPOSER_TEXTAREA_MIN_HEIGHT_PX,
}: {
  chromeReservePx?: number;
  minHeightPx?: number;
} = {}): string {
  return `max(${minHeightPx}px, min(300px, 40vh, calc(100dvh - var(--keyboard-height, 0px) - ${chromeReservePx}px)))`;
}
