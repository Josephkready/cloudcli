import { test, expect } from './fixtures';

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
