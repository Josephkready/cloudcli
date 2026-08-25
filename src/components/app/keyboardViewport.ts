/**
 * Keeps the fixed app shell aligned with the visible area while the iOS soft
 * keyboard is up.
 *
 * Two separate things go wrong on iOS, and they need separate answers:
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
 * Extracted from the component so both rules are testable against a fake
 * viewport; there is no way to provoke WebKit's scroll-into-view in a test.
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

/** Height the keyboard is covering. Clamped: the two viewports can disagree by a rounding error. */
export function computeKeyboardHeight(innerHeight: number, viewportHeight: number): number {
  return Math.max(0, innerHeight - viewportHeight);
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
 * Wires both rules to a window. Returns the teardown.
 *
 * No-ops without a Visual Viewport API — on Chrome for Android the layout
 * viewport shrinks by itself and `inset-0` already tracks it.
 */
export function installKeyboardViewportSync(win: WindowLike, doc: DocumentLike): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};

  let installed = true;
  let focusSamplingGeneration = 0;
  let lastPublishedKeyboardHeight: number | null = null;

  const applyKeyboardHeight = () => {
    const keyboardHeight = computeKeyboardHeight(win.innerHeight, viewport.height);
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
    applyKeyboardHeight();
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
    viewport.removeEventListener('resize', handleResize);
    viewport.removeEventListener('scroll', handleViewportScroll);
    win.removeEventListener('focusin', handleFocusIn);
  };
}
