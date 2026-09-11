import { test, expect } from './fixtures';
import { showKeyboard } from './keyboard';

/**
 * #361 — the quick-settings handle must not float above the mobile sidebar.
 *
 * The handle and the mobile sidebar overlay were both `z-50`. That is not a tie
 * the stacking context breaks in anyone's favour: it falls through to DOM order,
 * and the handle renders later, so it painted over the sidebar's dimmed backdrop
 * AND stayed hit-testable. On a phone it sits exactly where a thumb rests on the
 * right edge, so it was a realistic mis-tap into a state neither component is
 * designed for.
 *
 * Asserted by hit-testing with elementFromPoint, which is how the issue measured
 * it — a class assertion would pass on a `z-40` that some other rule overrode.
 *
 * Runs under the desktop chromium project with an explicit phone viewport rather
 * than a mobile project: the app derives `isMobile` purely from
 * `window.innerWidth` (see getIsMobile in useDeviceSettings), so a viewport
 * override is enough, and it keeps this spec out of the shared project filters.
 */
test.use({ viewport: { width: 390, height: 797 }, hasTouch: true });

const HANDLE = 'button[aria-label="Open settings panel"]';

test('the settings handle is not tappable through the open mobile sidebar', async ({ page }) => {
  await page.goto('/');

  const handle = page.locator(HANDLE);
  await expect(handle).toBeVisible();

  // Baseline: with the sidebar closed the handle is the top element at its own
  // centre. Without this the test could pass simply because the handle moved,
  // was hidden, or never rendered at all.
  const closed = await page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { handleIsOnTop: el.contains(hit) || el === hit };
  }, HANDLE);
  expect(closed.handleIsOnTop).toBe(true);

  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeVisible();

  const open = await page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy) as HTMLElement | null;
    return {
      handleIsOnTop: !!hit && (el === hit || el.contains(hit)),
      topElement: hit?.tagName ?? null,
      topElementLabel: hit?.getAttribute('aria-label') ?? null,
    };
  }, HANDLE);

  // The whole bug: a control belonging to the surface BEHIND a modal one, still
  // taking taps.
  expect(open.handleIsOnTop).toBe(false);
  // And what should be catching them instead — the sidebar's dismiss backdrop.
  expect(open.topElementLabel).toBe('Close sidebar');
});

test('the handle still works when the sidebar is closed', async ({ page }) => {
  // Guards against "fixing" the stacking by burying the handle outright.
  await page.goto('/');

  await page.locator(HANDLE).click();
  await expect(page.getByRole('button', { name: 'Close settings panel' })).toBeVisible();
});

/**
 * #474 — the handle must not land on top of the composer's send button once
 * the soft keyboard raises it.
 *
 * The handle used to be positioned from a JS-computed `bottom: Npx` derived
 * once from `window.innerHeight`, with no awareness of `--keyboard-height` at
 * all. On a tall enough phone the composer's rise to clear the keyboard put
 * its send button right where the handle (parked at its default 50% mark)
 * already was. See `handleStyle.test.ts` for the pure-logic coverage of the
 * replacement CSS calculation; this pins the same claim against real layout.
 *
 * Deliberately overrides this file's shared 390x797 viewport and the default
 * 336px `IOS_KEYBOARD_HEIGHT`: at those numbers the pre-fix arithmetic left a
 * 5.5px gap between the handle and the send button (confirmed by reverting
 * useQuickSettingsDrag.ts to its pre-fix logic and re-measuring) — narrowly
 * non-overlapping, so a regression back to that exact code would pass this
 * test undetected. 390x844 with a 400px keyboard is the geometry the original
 * QA sweep actually measured overlapping (17x35px) against the pre-fix code,
 * so it is what a regression guard needs to reproduce.
 */
test('the send button and the settings handle never overlap once the keyboard opens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();
  await composer.click();
  await showKeyboard(page, 400);

  const handle = page.locator(HANDLE);
  await expect(handle).toBeVisible();
  const sendButton = page.getByRole('button', { name: 'Send' });
  await expect(sendButton).toBeVisible();

  const [handleBox, sendBox] = await Promise.all([
    handle.boundingBox(),
    sendButton.boundingBox(),
  ]);
  if (!handleBox || !sendBox) {
    throw new Error('expected both the handle and the send button to have a layout box');
  }

  const intersects =
    handleBox.x < sendBox.x + sendBox.width &&
    handleBox.x + handleBox.width > sendBox.x &&
    handleBox.y < sendBox.y + sendBox.height &&
    handleBox.y + handleBox.height > sendBox.y;

  expect(intersects, `handle ${JSON.stringify(handleBox)} vs send ${JSON.stringify(sendBox)}`).toBe(false);
});
