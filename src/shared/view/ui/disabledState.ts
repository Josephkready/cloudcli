/**
 * The single disabled treatment for interactive controls (#276).
 *
 * Before this module, "disabled" meant a bare opacity drop on an already
 * saturated colour, at five different values across 21 files
 * (`opacity-30/40/50/60/75`). A blocked primary button therefore looked almost
 * identical to a live one, so it read as *broken* rather than *blocked*.
 *
 * The treatment defined here is:
 *
 * - `grayscale` — the non-colour cue. It drains the saturation instead of
 *   merely dimming it, so a blue/green/gradient control becomes a flat grey
 *   one. It is deliberately theme-agnostic (no `bg-muted`/`text-muted-*`
 *   tokens) because several controls live on the always-dark terminal chrome,
 *   where the light-theme tokens would look wrong.
 * - `opacity-60` — one value, everywhere.
 * - `shadow-none` — drops the raised "pressable" affordance.
 * - `cursor-not-allowed` — the pointer says blocked.
 *
 * The cursor only shows because `Button` no longer sets
 * `disabled:pointer-events-none`: the control stays hit-testable, so the cursor
 * and any `title` tooltip can explain the block, while the native `disabled`
 * attribute still blocks activation. `Button`, `Input` and `CommandInput` now
 * agree on this.
 *
 * Import these instead of hand-writing `disabled:opacity-*` at a call site.
 * `disabledState.test.ts` fails the build if a new one appears anywhere else.
 *
 * NOTE: the class strings must stay written out in full (no interpolation of
 * the `not-allowed`/`wait` fragment) so Tailwind's content scanner can see
 * them.
 */

/** Shared, cursor-independent half of the treatment. */
const DISABLED_APPEARANCE = 'disabled:opacity-60 disabled:grayscale disabled:shadow-none';

/** The default treatment: this control is blocked and will not act. */
export const disabledControlClasses = `disabled:cursor-not-allowed ${DISABLED_APPEARANCE}`;

/**
 * Same appearance, but for controls that are disabled only because their own
 * action is already in flight — "busy", not "blocked".
 */
export const disabledBusyControlClasses = `disabled:cursor-wait ${DISABLED_APPEARANCE}`;
