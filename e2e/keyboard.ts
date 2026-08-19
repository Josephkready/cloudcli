import type { Locator, Page } from '@playwright/test';

import { expect } from './fixtures';

/**
 * Soft-keyboard test primitives, in a real browser.
 *
 * ## Why this exists
 *
 * The keyboard rules were previously covered only by `keyboardViewport.test.ts`,
 * which runs in node against a hand-written `WindowLike`/`VisualViewportLike`
 * fake. That suite passes today and passed throughout #346, #354 and #357 — it
 * cannot do otherwise, because the same author supplies both the fake viewport
 * and the expectation, so it asserts a *model of iOS* rather than a browser's
 * behaviour. Worse, it never evaluates a line of CSS: `bottom:
 * var(--keyboard-height, 0px)` is a string it compares to another string, so a
 * surface that ignores the variable entirely is invisible to it.
 *
 * These helpers move both questions into an engine that actually lays out. Note
 * the questions are genuinely separate, and conflating them is how the last fix
 * shipped broken:
 *
 * | | asks | primitive |
 * |---|---|---|
 * | **Consumer** | given a keyboard height, does this surface render clear of it? | {@link showKeyboard} |
 * | **Publisher** | given a shrinking viewport, is the right height published? | {@link shrinkVisualViewport} |
 *
 * A consumer test that publishes the variable itself proves nothing about the
 * publisher, and vice versa. Each is labelled so neither is mistaken for the
 * other.
 */

/**
 * Keyboard height to test against, in CSS pixels.
 *
 * iOS 18 on a 390×797 viewport (the geometry both #354 and #357 were reported
 * from) leaves roughly 460px visible with the keyboard up. The exact number is
 * not load-bearing — every assertion here is relative to the measured layout
 * viewport — but a realistic one keeps failures legible.
 */
export const IOS_KEYBOARD_HEIGHT = 336;

/**
 * Publishes `--keyboard-height`, exactly as `installKeyboardViewportSync` does
 * when the real keyboard opens.
 *
 * This is the **consumer** primitive: it takes the publisher as given and asks
 * whether each surface responds. That is deliberate — it is the half that needs
 * no emulation, runs identically in WebKit and Chromium, and is the half that
 * was never tested. A surface that never reads the variable fails here no matter
 * which engine or device is in play.
 */
export async function showKeyboard(page: Page, height: number = IOS_KEYBOARD_HEIGHT): Promise<void> {
  await page.evaluate((px) => {
    document.documentElement.style.setProperty('--keyboard-height', `${px}px`);
  }, height);
}

/** Retracts the keyboard published by {@link showKeyboard}. */
export async function hideKeyboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--keyboard-height', '0px');
  });
}

/**
 * The y coordinate of the keyboard's top edge.
 *
 * Measured against `innerHeight` — the *layout* viewport — because that is the
 * one iOS leaves alone when the keyboard opens, and therefore the coordinate
 * space `getBoundingClientRect` reports in. Deriving it from the Playwright
 * viewport option instead would silently drift the moment a test overrides it.
 */
export async function keyboardLine(
  page: Page,
  height: number = IOS_KEYBOARD_HEIGHT,
): Promise<number> {
  return page.evaluate((px) => window.innerHeight - px, height);
}

/**
 * Asserts an element renders fully above the keyboard.
 *
 * Checks the element's **bottom** edge: a field whose top is visible but whose
 * bottom is buried is still a field you cannot see what you are typing into,
 * which is precisely the complaint in #354.
 */
export async function expectClearsKeyboard(
  page: Page,
  target: Locator,
  height: number = IOS_KEYBOARD_HEIGHT,
): Promise<void> {
  const line = await keyboardLine(page, height);

  // Polled, not sampled once. A single `boundingBox()` immediately after the
  // variable changes races the layout that the change triggers — under a loaded
  // machine this suite failed and passed on the same code, which is worse than
  // no suite at all. The claim being tested is about the *settled* position: the
  // user's complaint is a field that stays buried, not one that is briefly
  // mid-transition. A genuinely broken surface never settles into a passing
  // position, so this retry cannot paper one over — it only removes the race.
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        return box ? Math.round(box.y + box.height) : null;
      },
      { message: `element bottom must settle above the keyboard line (${line}px)` },
    )
    .toBeLessThanOrEqual(line);
}

/**
 * Reproduces the iOS keyboard's viewport signature: `window.innerHeight`
 * unchanged, `visualViewport.height` reduced, then a `resize` on the real
 * `visualViewport` so the app's own listeners run.
 *
 * ## Why the numbers are synthesised
 *
 * The fully-real route was tried first and does not work *on this app*. CDP's
 * `Emulation.setPageScaleFactor` genuinely shrinks the visual viewport and fires
 * a genuine `resize` (measured: 660px viewport → `innerHeight: 660,
 * visualViewport.height: 366.7`), but `index.html` ships
 * `maximum-scale=1.0, minimum-scale=1.0, user-scalable=no`, which clamps page
 * scale to 1 and makes it a silent no-op here. It was only convincing on a toy
 * page that carried no such clamp. `Emulation.setVisibleSize` is a no-op in
 * current Chromium (measured: viewport unchanged, no event). Neither should be
 * reached for again without re-measuring.
 *
 * ## What is real and what is not
 *
 * Real: the DOM, the CSS cascade, layout, the app's actual listeners, and the
 * event dispatch. Synthetic: the two numbers `height` and `offsetTop`, shadowed
 * as own properties on the live `VisualViewport` instance.
 *
 * That is a far smaller fiction than the node suite's hand-built `WindowLike`,
 * which fakes the window, the document, the element tree and the CSS too. But it
 * is still a fiction, and it bounds what these tests can claim: they verify what
 * the app does **when told the viewport changed**, never *whether iOS tells it*.
 * A keyboard bug whose cause is an event iOS never fires — or fires at a moment
 * this cannot reproduce — is out of reach of any local harness, and only a real
 * device settles it.
 *
 * Engine-agnostic, unlike the CDP route, so the publisher rules can be pinned in
 * WebKit as well.
 */
export async function shrinkVisualViewport(page: Page, keyboardHeight: number): Promise<void> {
  await page.evaluate((keyboard) => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('visualViewport is unavailable in this browser');
    const visibleHeight = window.innerHeight - keyboard;
    Object.defineProperty(viewport, 'height', { configurable: true, get: () => visibleHeight });
    viewport.dispatchEvent(new Event('resize'));
  }, keyboardHeight);
}

/**
 * Restores the real viewport metrics and announces it, as closing the keyboard
 * would. Paired with {@link shrinkVisualViewport} so a test can assert the
 * retraction as well as the extension.
 */
export async function restoreVisualViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    delete (viewport as unknown as Record<string, unknown>).height;
    viewport.dispatchEvent(new Event('resize'));
  });
}

/**
 * Focuses an element the way a tap does, so `focusin` reaches the app's
 * listener. `Locator.focus()` is not enough on its own for elements the app
 * only reacts to via bubbled focus events.
 */
export async function focusField(page: Page, selector: string): Promise<void> {
  await page.evaluate((css) => {
    document.querySelector<HTMLElement>(css)?.focus();
  }, selector);
}

/** Reads back what the app currently believes the keyboard height to be. */
export async function readPublishedKeyboardHeight(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--keyboard-height').trim(),
  );
}
