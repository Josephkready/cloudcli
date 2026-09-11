import { HANDLE_KEYBOARD_RESERVE_PX } from './constants';
import type { QuickSettingsHandleStyle } from './types';

/**
 * Positions the quick-settings drag handle, expressed entirely as CSS
 * `var()`/`calc()`/`min()`/`max()` rather than a JS-computed pixel value.
 *
 * ## The bug this replaces (cloudcli#474)
 *
 * The previous implementation read `window.innerHeight` once inside a
 * `useMemo` keyed on `[handlePosition, isMobile]` and multiplied it by the
 * drag percentage to get a `bottom` (mobile) or `top` (desktop) pixel value.
 * Two failures fell out of that:
 *
 * 1. **No keyboard awareness.** The soft keyboard raises the chat composer
 *    (via the app's own `--keyboard-height` custom property — see
 *    `keyboardViewport.ts`) but never touches `window.innerHeight` on this
 *    app's iOS configuration, so the handle never moved out of the way and
 *    could land on top of the raised composer/send button.
 * 2. **Stale on resize.** Because the pixel value was computed once and the
 *    `useMemo` never depended on the viewport size, rotating the phone (or
 *    any other resize) left the handle at its old absolute pixel offset —
 *    now measured against a viewport of a different height, so it could end
 *    up anywhere, including off in unrelated content.
 *
 * Expressing the position as a CSS calculation sidesteps both: `100%`
 * resolves against the *current* containing-block height on every layout the
 * browser performs (no JS resize listener needed, so no staleness is
 * possible), and folding `var(--keyboard-height, 0px)` into the formula keeps
 * the handle above the keyboard the same way the rest of the app does.
 *
 * ## The reserved band (mobile only)
 *
 * `reservedBottomPx` is a floor applied to the **mobile** drag range: no
 * matter what the drag percentage or the keyboard height says, the handle
 * cannot come closer than this many pixels to the keyboard line (or, with no
 * keyboard, the bottom of the screen) — enough room for the resting composer
 * and its send button. This also fixes a narrower, pre-existing version of
 * the same bug: dragging the handle to its minimum position (10%) could
 * already overlap the composer even with no keyboard up.
 *
 * The **desktop** branch deliberately does NOT apply this reserve. An early
 * version did, and review caught that it silently compressed the normal
 * desktop drag range: at any real laptop window height under ~1600px (i.e.
 * effectively all of them), `min(handlePosition%, calc(100% - 160px))`
 * clamps a saved position anywhere above ~75-84% even with no keyboard in
 * sight, which is a real, unannounced behaviour change for mouse users this
 * bug was never about. Desktop only needs the keyboard term — a mouse-driven
 * session never has `--keyboard-height` above 0, so `min(handlePosition%,
 * calc(100% - 0px))` is exactly `handlePosition%`, i.e. pixel-identical to
 * the pre-fix behaviour. The only case the desktop ceiling actually engages
 * is a touch session pushed into this layout by width alone (a phone
 * rotated to landscape crosses the 768px breakpoint — see cloudcli#475),
 * where it at least keeps the handle inside the visible area; it does not
 * fully clear the composer there, which is why #475 is tracked separately
 * rather than folded into this reserve.
 */
export function computeHandleStyle({
  isMobile,
  handlePosition,
  reservedBottomPx = HANDLE_KEYBOARD_RESERVE_PX,
}: {
  isMobile: boolean;
  handlePosition: number;
  reservedBottomPx?: number;
}): QuickSettingsHandleStyle {
  const keyboard = 'var(--keyboard-height, 0px)';

  if (!isMobile) {
    // Desktop drag range: a percentage from the top, vertically centred.
    // Ceiling'd (via `min`, since `top` grows downward) only by the keyboard
    // height — see "The reserved band (mobile only)" above for why this does
    // NOT also subtract `reservedBottomPx`. `reservedBottomPx` is accepted
    // but unused on this branch so the two branches share one call signature.
    return {
      top: `min(${handlePosition}%, calc(100% - ${keyboard}))`,
      transform: 'translateY(-50%)',
    };
  }

  // Mobile drag range: `bottom` offset, so "closer to 0" means closer to the
  // bottom of the screen. Two terms, and the larger one wins:
  //   - the reserved floor: never closer than `reservedBottomPx` to the
  //     keyboard line (or the screen bottom, when `keyboard` is 0);
  //   - the proportional position: `handlePosition`% of the space ABOVE the
  //     keyboard, shifted up by the keyboard height so it is measured from
  //     the keyboard line rather than the (possibly keyboard-covered) true
  //     bottom of the screen.
  //
  // `handlePosition` comes from live pixel-delta drag math, so production
  // values are rarely round numbers (e.g. 33.333...). Rounded to 4 decimal
  // places purely for output hygiene — `33.333 / 100` is
  // `0.33332999999999996` in IEEE-754, and embedding that verbatim in a CSS
  // string serves no one. 4 places is far finer than a CSS pixel can resolve
  // at any realistic viewport height, so this rounding is not observable in
  // rendered layout.
  const fraction = Math.round((handlePosition / 100) * 10_000) / 10_000;
  return {
    bottom: `max(calc(${keyboard} + ${reservedBottomPx}px), calc(${keyboard} + (100% - ${keyboard}) * ${fraction}))`,
  };
}
