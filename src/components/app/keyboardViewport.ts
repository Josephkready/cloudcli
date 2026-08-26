/**
 * Keeps the fixed app shell aligned with the visible area while the iOS soft
 * keyboard is up.
 *
 * Three separate things go wrong on iOS, and they need separate answers:
 *
 * 1. The layout viewport does not shrink when the keyboard opens — only the
 *    visual viewport does — so a `position: fixed; inset: 0` shell keeps its
 *    full height and its bottom edge (the composer) sits behind the keyboard.
 *    Answer: publish the keyboard height as `--keyboard-height` and let the
 *    shell raise its own bottom edge. This is long-standing behaviour.
 *
 * 2. Before that adjustment lands, WebKit has already run its own
 *    scroll-into-view for the newly focused field, displacing the viewport
 *    upward by roughly the keyboard height. Once (1) applies, that displacement
 *    is double-counted: the shell is both shortened *and* pushed up, so it
 *    leaves the visible area entirely and the page renders blank — #334's
 *    "it scrolls so far down the entire screen is white". It is intermittent
 *    because it depends on whether WebKit decided to scroll before our resize
 *    handler ran. Answer: pin the viewport back to the origin. The document is
 *    `overflow: hidden` and the shell is fixed, so a non-zero document scroll
 *    is never legitimate here — undoing it can only ever remove the artefact.
 *
 * 3. The gap between the two viewports is not zero when no keyboard is up. That
 *    is the assumption behind reading the keyboard height as a difference, and
 *    on standalone (home-screen) iOS PWAs it is false by a constant amount, so
 *    the resting state reads as a permanent phantom keyboard. Answer: calibrate
 *    that constant from samples taken while no text field has focus, and report
 *    only what exceeds it. See `reviseRestingViewportGap`.
 *
 * Extracted from the component so the rules are testable against a fake
 * viewport; there is no way to provoke WebKit's scroll-into-view in a test.
 *
 * The bound on all of it, and it is a hard one: standalone display mode is the
 * one environment none of this can be exercised in. Playwright cannot enter it,
 * so neither the WebKit e2e sweep nor any node fake reaches the state these
 * rules exist for. The suites pin the behaviour; only a device confirms the bug.
 */

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface WindowLike {
  innerHeight: number;
  scrollY: number;
  visualViewport?: VisualViewportLike | null;
  scrollTo(x: number, y: number): void;
  requestAnimationFrame(callback: (timestamp: number) => void): number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

// iOS can finish its keyboard animation without delivering a usable final
// VisualViewport resize. Keep the focus fallback alive long enough to observe
// that settled geometry even on a 120Hz screen. The work is only two numbers
// and a conditional CSS write per frame, and stops immediately when focus leaves
// the text field.
const KEYBOARD_FOCUS_SETTLE_MS = 1000;

export interface DocumentLike {
  activeElement: { tagName?: string; isContentEditable?: boolean } | null;
  documentElement: { style: { setProperty(property: string, value: string): void } };
}

/**
 * Style that raises an element's bottom edge clear of the soft keyboard.
 *
 * Needed by every `position: fixed` surface that can hold a text field, not just
 * the app shell. A fixed element is laid out against the viewport, so nesting it
 * inside the shell does **not** inherit the shell's raised bottom edge — the
 * mobile sidebar overlay, which hosts the new-conversation folder picker and its
 * search box, kept full height and sat behind the keyboard for exactly that
 * reason (#346).
 *
 * The `0px` fallback is load-bearing: `installKeyboardViewportSync` never sets
 * `--keyboard-height` without a Visual Viewport API, so the declaration has to
 * degrade to `inset-0` on its own everywhere else.
 */
export function keyboardAwareBottomStyle(
  style: Record<string, unknown> = {},
): Record<string, unknown> & { bottom: string } {
  return { ...style, bottom: 'var(--keyboard-height, 0px)' };
}

/**
 * Inset for a `position: fixed` surface that must span the whole layout viewport.
 *
 * Set inline, and without the `inset-0` utility, on purpose. `src/index.css`
 * carries an app-global `body.pwa-mode .fixed.inset-0` rule that moves the origin
 * of *any* element carrying both classes down by the header safe area, and
 * `pwa-mode` is only added in standalone display mode — so the shift exists in
 * the installed home-screen PWA and in no browser, emulator or test. Everything
 * here counts from the layout viewport's origin: `--keyboard-height` is derived
 * from `window.innerHeight`, which is measured from y=0, so a shell whose box
 * starts lower is being driven by a number from a different coordinate space.
 *
 * Following MetalZealot/CLIde ADR 0010, the answer is for the surface to state
 * its own inset rather than to fight the rule from the other side: inline wins
 * against it, and there is nothing left to remember. The safe-area treatment the
 * rule was providing is preserved as *padding* by `.pwa-shell-safe`, which insets
 * the content without moving the box.
 */
export function viewportShellStyle(
  style: Record<string, unknown> = {},
): Record<string, unknown> & { top: string; right: string; bottom: string; left: string } {
  return { ...keyboardAwareBottomStyle(style), top: '0px', right: '0px', left: '0px' };
}

/**
 * Height the keyboard is covering.
 *
 * `restingGap` is what the two viewports disagree by with *no* keyboard up; see
 * {@link reviseRestingViewportGap}. Floored at zero, because the raw difference
 * and the resting-gap subtraction can each go slightly negative from rounding.
 */
export function computeKeyboardHeight(
  innerHeight: number,
  viewportHeight: number,
  restingGap = 0,
): number {
  return Math.max(0, innerHeight - viewportHeight - restingGap);
}

/**
 * The `innerHeight - viewportHeight` disagreement that is *not* the keyboard.
 *
 * The keyboard height is read as the gap between the layout and visual
 * viewports, which assumes the gap is zero when no keyboard is up. On standalone
 * iOS PWAs it is not: the two disagree by a constant amount — the suspected
 * cause is disagreement over whether the home-indicator area counts, though the
 * fix needs only the disagreement to be constant, not its cause — so the resting
 * state reads as a permanent phantom keyboard and leaves a gap under the
 * composer at rest.
 *
 * Calibrated rather than guessed, under three rules that between them make a
 * wrong value self-correcting:
 *
 * - **Only samples with no text field focused count.** With the keyboard up the
 *   gap is the keyboard, and adopting it would make the keyboard measure zero —
 *   the original bug. A `null` return means "not calibrated yet", which callers
 *   read as zero: over-reporting the keyboard costs a small gap, under-reporting
 *   it puts the composer behind the keyboard, and only one of those is the bug.
 * - **It only ever shrinks.** Focus leaves a field before iOS finishes
 *   retracting the keyboard, so a sample can arrive unfocused while the viewport
 *   is still short. Taking the minimum means such a sample cannot inflate the
 *   baseline; the settled sample that follows is the one that lands.
 * - **A negative difference is discarded, not floored to zero.** The visual
 *   viewport is never genuinely taller than the layout viewport, so a negative
 *   reading is proof the two numbers were sampled mid-transition and carries no
 *   information about the resting state. Flooring it to zero would instead turn
 *   the least trustworthy sample there is into the most confident claim the
 *   baseline can hold — and because the baseline only shrinks, that zero would
 *   then be permanent. This is reachable: `interactive-widget=resizes-content`
 *   means both numbers move when the keyboard retracts, they need not move in
 *   the same tick, and focus is already gone by then, so the rule above does not
 *   cover it. The symptom would be the phantom gap coming back for good.
 *
 * The residual: a rotation whose true resting gap is *larger* keeps the smaller
 * calibration and leaves a proportionally small phantom, since nothing raises the
 * baseline. That is strictly better than the fixed zero it replaces, and the
 * safe direction to be wrong in. Deliberately no "reject a large downward jump"
 * heuristic on top: the skew that motivates one shows up as a negative or an
 * oversized reading, both already handled, and a fractional threshold would be a
 * tuning knob no test on this hardware could calibrate.
 */
export function reviseRestingViewportGap(
  current: number | null,
  sample: { innerHeight: number; viewportHeight: number; textEntryFocused: boolean },
): number | null {
  if (sample.textEntryFocused) return current;
  const gap = sample.innerHeight - sample.viewportHeight;
  if (gap < 0) return current;
  return current === null ? gap : Math.min(current, gap);
}

/** Does this element take text, i.e. is it the kind of focus that summons the keyboard? */
export function isTextEntryElement(
  element: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!element) return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * Is the viewport sitting somewhere it has no business being?
 *
 * A non-zero document scroll always qualifies — nothing in this app scrolls the
 * document. A non-zero `offsetTop` only qualifies while a text field holds
 * focus: iOS also shifts it while the URL bar collapses during ordinary
 * scrolling, and correcting *that* would fight the browser on every gesture.
 */
export function isViewportDisplaced(input: {
  scrollY: number;
  viewportOffsetTop: number;
  textEntryFocused: boolean;
}): boolean {
  if (input.scrollY > 0) return true;
  return input.textEntryFocused && input.viewportOffsetTop > 0;
}

/**
 * Wires all three rules to a window. Returns the teardown.
 *
 * No-ops without a Visual Viewport API — on Chrome for Android the layout
 * viewport shrinks by itself and `inset-0` already tracks it.
 */
export function installKeyboardViewportSync(win: WindowLike, doc: DocumentLike): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};

  let installed = true;
  let focusSamplingGeneration = 0;
  let resizeSamplingGeneration = 0;
  let lastPublishedKeyboardHeight: number | null = null;

  const sampleViewport = () => ({
    innerHeight: win.innerHeight,
    viewportHeight: viewport.height,
    textEntryFocused: isTextEntryElement(doc.activeElement),
  });

  // Seeded from the geometry at mount, which is the app's best chance at a
  // resting sample: nothing is focused yet, so the two viewports are showing
  // their standing disagreement and nothing else. Re-calibrated by every later
  // resting sample — see `reviseRestingViewportGap` for why that can only help.
  let restingViewportGap = reviseRestingViewportGap(null, sampleViewport());

  const applyKeyboardHeight = () => {
    const sample = sampleViewport();
    restingViewportGap = reviseRestingViewportGap(restingViewportGap, sample);
    const keyboardHeight = computeKeyboardHeight(
      sample.innerHeight,
      sample.viewportHeight,
      restingViewportGap ?? 0,
    );
    if (keyboardHeight === lastPublishedKeyboardHeight) {
      return;
    }
    lastPublishedKeyboardHeight = keyboardHeight;
    doc.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
  };

  const pinViewport = () => {
    if (!isViewportDisplaced({
      scrollY: win.scrollY,
      viewportOffsetTop: viewport.offsetTop,
      textEntryFocused: isTextEntryElement(doc.activeElement),
    })) {
      return;
    }
    win.scrollTo(0, 0);
  };

  const handleResize = () => {
    // Only resize matters for the height — keyboard open/close is the only
    // thing that changes `viewport.height`. Deriving it from `offsetTop`, or
    // recomputing it on scroll, makes the value fluctuate during ordinary
    // scrolling and the shell visibly bounces.
    //
    // Read two frames late, not in the handler. `index.html` asks for
    // `interactive-widget=resizes-content`, so the browser already shrinks
    // `window.innerHeight` for the keyboard by itself — but on standalone iOS
    // PWAs it does not do so in the same tick as this event. Sampling now can
    // catch `innerHeight` still at its full value against a visual viewport that
    // has already shrunk, which reads as a whole keyboard's worth of gap and
    // stacks a second shift on top of the browser's own. Two frames is enough
    // for both numbers to settle.
    //
    // The generation makes a later resize replace an in-flight read rather than
    // queue behind it, which keeps a keyboard animation's burst of resizes from
    // piling up two frames of work each. It is deliberately untested: the read
    // samples live state rather than anything captured at dispatch, so a stale
    // callback would compute the identical number and the dedupe below would
    // swallow it. There is no observable difference to assert, and a test that
    // passes either way is worse than none.
    const generation = ++resizeSamplingGeneration;
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(() => {
        if (!installed || generation !== resizeSamplingGeneration) return;
        applyKeyboardHeight();
      });
    });
    // Now, and again after the frame WebKit uses to apply its own
    // scroll-into-view — whichever of the two ran first, one of these lands
    // after it.
    pinViewport();
    win.requestAnimationFrame(pinViewport);
  };

  const handleViewportScroll = () => {
    pinViewport();
  };

  const handleFocusIn = () => {
    // Focus is the second place we know a keyboard is wanted, and `resize` is
    // otherwise the only publisher of the height — one event to miss. A focus
    // that arrives without one (keyboard already up from another field, a resize
    // swallowed while the chat view was mounting, a resize sampled mid-slide)
    // used to leave `--keyboard-height` unset, so the shell kept full height and
    // the composer stayed behind the keyboard (#346).
    //
    // Sampled on the next frame, not during the event: both the height and the
    // displacement are applied after focus. Idempotent with the resize path —
    // when that already published the settled value this leaves it unchanged,
    // which is why the two cannot fight.
    // One next-frame sample is still too early on affected iPhones: #442
    // captured a 797px layout viewport, a settled 394px visual viewport, and a
    // published 0px inset. That is the signature of the first focus sample
    // landing before the keyboard animation and no later usable resize event.
    // Sample for a bounded animation window so the final geometry wins even in
    // that ordering. A generation makes repeated focus changes replace, rather
    // than multiply, the active sampler.
    const generation = ++focusSamplingGeneration;
    let startedAt: number | null = null;

    const sampleFocusedViewport = (timestamp: number) => {
      if (
        !installed
        || generation !== focusSamplingGeneration
        || !isTextEntryElement(doc.activeElement)
      ) {
        return;
      }

      startedAt ??= timestamp;
      applyKeyboardHeight();
      pinViewport();

      if (timestamp - startedAt < KEYBOARD_FOCUS_SETTLE_MS) {
        win.requestAnimationFrame(sampleFocusedViewport);
      }
    };

    win.requestAnimationFrame(sampleFocusedViewport);
  };

  viewport.addEventListener('resize', handleResize);
  viewport.addEventListener('scroll', handleViewportScroll);
  win.addEventListener('focusin', handleFocusIn);

  return () => {
    installed = false;
    focusSamplingGeneration += 1;
    resizeSamplingGeneration += 1;
    viewport.removeEventListener('resize', handleResize);
    viewport.removeEventListener('scroll', handleViewportScroll);
    win.removeEventListener('focusin', handleFocusIn);
  };
}
