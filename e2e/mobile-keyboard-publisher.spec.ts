import { test, expect } from './fixtures';
import { publishedKeyboardHeight, shrinkVisualViewport } from './keyboard';

/**
 * The publisher half: given a real shrinking visual viewport, does the app
 * publish the right `--keyboard-height`?
 *
 * Kept apart from the geometry sweep on purpose. The sweep publishes the
 * variable itself to ask whether each surface *responds* to it; doing both in
 * one test is not a stronger test but a meaningless one, because the live
 * publisher overwrites whatever the test wrote and the assertion ends up
 * measuring the publisher through the consumer. That is not hypothetical — it
 * is exactly how the first draft of the switching test failed.
 *
 * Runs on both engines. What is synthetic here is narrow and stated in
 * `keyboard.ts`: the two viewport *numbers*. The listeners, the event dispatch,
 * the DOM and the CSS are all the app's own. The bound that follows from that is
 * worth keeping in view — these tests pin what the app does **when told the
 * viewport changed**, and can say nothing about whether iOS tells it, or when.
 */

test.use({
  viewport: { width: 390, height: 797 },
  hasTouch: true,
  isMobile: true,
});

const KEYBOARD = 336;
const publishedHeight = publishedKeyboardHeight;

test('publishes the keyboard height when the visual viewport really shrinks', async ({ page }) => {
  await page.goto('/');
  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();

  expect(await publishedHeight(page)).toBe(0);

  await composer.click();
  await shrinkVisualViewport(page, KEYBOARD);

  // Page scale is a ratio, so the reachable height is not exactly `KEYBOARD`;
  // what matters is that a substantial keyboard was noticed at all, not that it
  // matched to the pixel.
  await expect.poll(() => publishedHeight(page)).toBeGreaterThan(KEYBOARD * 0.8);
});

test('a focus that arrives with the keyboard already up does not erase the height (#354)', async ({
  page,
}) => {
  // The #357 reporter's sequence, and the suspected #354 mechanism: the keyboard
  // is already up, and focus moves to a second field without the viewport
  // changing. `handleFocusIn` re-samples and *rewrites* the height on that
  // focus. If it ever samples a viewport that has not shrunk — or has already
  // sprung back — it publishes 0, the shell drops to full height, and the
  // composer lands under the keyboard. Nothing republishes it, because the
  // resize that would have has already been and gone.
  await page.goto('/');
  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();

  await composer.click();
  await shrinkVisualViewport(page, KEYBOARD);
  await expect.poll(() => publishedHeight(page)).toBeGreaterThan(KEYBOARD * 0.8);
  const settled = await publishedHeight(page);

  // Focus a second field with the viewport unchanged — the keyboard stays up.
  await page.getByRole('button', { name: 'Report a bug' }).click();
  const reportField = page.locator('#bug-report-description');
  await expect(reportField).toBeVisible();
  await reportField.click();

  await expect
    .poll(() => publishedHeight(page), {
      message: 'focusing a second field must not retract a keyboard that is still up',
    })
    .toBeGreaterThan(settled * 0.8);
});

test('keeps sampling after focus when iOS settles without another resize (#442)', async ({ page }) => {
  await page.goto('/');
  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();

  await composer.click();
  await page.evaluate(async (keyboard) => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('visualViewport is unavailable in this browser');

    // Let the focus fallback take its first sample while the viewport is still
    // full-height, then settle at the keyboard geometry without dispatching a
    // resize. This is #442's captured state: visual viewport short, published
    // inset still 0px.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const visibleHeight = window.innerHeight - keyboard;
    Object.defineProperty(viewport, 'height', { configurable: true, get: () => visibleHeight });
  }, KEYBOARD);

  await expect
    .poll(() => publishedHeight(page), {
      message: 'focus sampling must catch a keyboard that settles without another resize',
    })
    .toBeGreaterThan(KEYBOARD * 0.8);
});
