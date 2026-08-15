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
  requestAnimationFrame(callback: () => void): number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface DocumentLike {
  activeElement: { tagName?: string; isContentEditable?: boolean } | null;
  documentElement: { style: { setProperty(property: string, value: string): void } };
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

  const applyKeyboardHeight = () => {
    const keyboardHeight = computeKeyboardHeight(win.innerHeight, viewport.height);
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
    // The displacement is applied after focus, so sample on the next frame
    // rather than during the event.
    win.requestAnimationFrame(pinViewport);
  };

  viewport.addEventListener('resize', handleResize);
  viewport.addEventListener('scroll', handleViewportScroll);
  win.addEventListener('focusin', handleFocusIn);

  return () => {
    viewport.removeEventListener('resize', handleResize);
    viewport.removeEventListener('scroll', handleViewportScroll);
    win.removeEventListener('focusin', handleFocusIn);
  };
}
