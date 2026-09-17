import { test, expect } from './fixtures';
import { showKeyboard, expectClearsKeyboard } from './keyboard';

/**
 * cloudcli#475 — a phone rotated to landscape (844x390 CSS px, an iPhone 14's
 * real landscape dimensions) hit three related failures, all traced to the
 * same root cause: the composer had no awareness of the *visible*
 * (keyboard-shrunk, short) viewport, and the mobile/desktop layout split
 * looked at viewport WIDTH alone.
 *
 * 1. The composer's bottom edge settled 14px past the keyboard line — a
 *    260px simulated keyboard on this 390px-tall viewport left only a 130px
 *    visible strip, and the composer's static height didn't account for it.
 *    Fixed in `composerTextareaHeight.ts`: the textarea's max-height is now
 *    `min(300px, 40vh, <visible height minus keyboard minus chrome>)` instead
 *    of a fixed `40vh`/`300px`.
 * 2. Typing a 12-line message grew the composer to 300px tall (the old static
 *    `sm:max-h-[300px]` ceiling, applied purely by *width* with no regard for
 *    this viewport's 390px *height*), pushing the send button 39px past the
 *    bottom of the viewport — unreachable without deleting text first. Same
 *    fix as (1): the dynamic ceiling also bounds unconstrained growth.
 * 3. At 844px width the app crossed its 768px mobile breakpoint into the
 *    desktop layout — a fixed sidebar and, more importantly, a composer with
 *    none of the above height awareness — even though the device is still a
 *    phone. Fixed in `isMobileViewport.ts`: `computeIsMobile` now also
 *    treats a coarse-pointer/no-hover device (touch, never a mouse) as
 *    mobile regardless of width.
 *
 * Runs under the desktop chromium project with an explicit phone-landscape
 * viewport and touch context — it keeps this spec out of the shared mobile-safari/
 * mobile-chrome project filters (see playwright.config.ts's KEYBOARD_SPECS
 * comment) while still exercising the exact `pointer: coarse`/`hover: none`
 * signal (3) depends on.
 */

const LANDSCAPE_VIEWPORT = { width: 844, height: 390 };

// Real iOS/Android software keyboards are shorter in landscape than portrait —
// this is the geometry the original QA sweep measured cloudcli#475's first
// failure against: a 260px keyboard leaves a 130px-tall visible strip on a
// 390px-tall viewport (vs. e.g. 336-400px assumed for a 797/844px-tall
// portrait viewport elsewhere in this suite).
const LANDSCAPE_KEYBOARD_HEIGHT = 260;

test.use({ viewport: LANDSCAPE_VIEWPORT, isMobile: true, hasTouch: true });

const COMPOSER = '[data-slot="prompt-input-textarea"]';

test('landscape phone: composer clears the keyboard line at rest (#475 defect 1)', async ({ page }) => {
  await page.goto('/');
  const composer = page.locator(COMPOSER);
  await expect(composer).toBeVisible();
  await composer.click();

  await showKeyboard(page, LANDSCAPE_KEYBOARD_HEIGHT);

  await expectClearsKeyboard(page, composer, LANDSCAPE_KEYBOARD_HEIGHT);
});

test('landscape phone: a 12-line message keeps the send button inside the viewport (#475 defect 2)', async ({ page }) => {
  await page.goto('/');
  const composer = page.locator(COMPOSER);
  await expect(composer).toBeVisible();
  await composer.click();

  // No keyboard simulated here, matching how the issue's own repro measured
  // this failure: textarea growth alone, against the plain 390px viewport
  // height, is enough to push the send button off-screen pre-fix.
  const longMessage = Array.from(
    { length: 12 },
    (_, i) => `Line ${i + 1}: a long test line to force the composer to grow across multiple rows.`,
  ).join('\n');
  await composer.fill(longMessage);

  const sendButton = page.getByRole('button', { name: 'Send' });
  await expect(sendButton).toBeVisible();

  // Polled rather than sampled once: the textarea's autosize (resizeTextarea)
  // runs off the input event and needs a layout pass to settle.
  await expect
    .poll(
      async () => {
        const box = await sendButton.boundingBox();
        return box ? Math.round(box.y + box.height) : null;
      },
      { message: `send button must settle inside the ${LANDSCAPE_VIEWPORT.height}px-tall viewport` },
    )
    .toBeLessThanOrEqual(LANDSCAPE_VIEWPORT.height);

  const sendBox = await sendButton.boundingBox();
  expect(sendBox?.y, 'send button top must also be on-screen').toBeGreaterThanOrEqual(0);
});

test('landscape phone: a coarse-pointer touch device stays on the mobile layout past the 768px width breakpoint (#475 defect 3)', async ({ page }) => {
  await page.goto('/');

  // MainContentHeader only renders this button when `isMobile` is true. At
  // 844px width the pre-fix, width-only `getIsMobile` would have selected the
  // desktop layout instead (see isMobileViewport.ts); this file's touch
  // context (`isMobile: true, hasTouch: true`) produces `pointer: coarse` and
  // `hover: none`, which is the signal that now keeps a landscape phone on
  // the mobile layout regardless of its width.
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
});
