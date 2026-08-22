import type { Page } from '@playwright/test';

import { test, expect } from './fixtures';
import {
  IOS_KEYBOARD_HEIGHT,
  focusField,
  readPublishedKeyboardHeight,
  retractKeyboardOnBlur,
  showKeyboard,
} from './keyboard';

/**
 * A bug report filed while the keyboard is up has to *say* the keyboard was up.
 *
 * ## Why this exists
 *
 * #358 added three viewport rows to every report — layout, visible, and the
 * inset the app believes is covered — because #354 and #357 both arrived saying
 * only `Viewport: 390×797`, a number iOS leaves identical whether or not the
 * keyboard is up. Their disagreement was supposed to be the diagnosis:
 *
 * | report shows | means |
 * |---|---|
 * | layout == visible, keyboard up | the app was never told |
 * | visible short, inset `0` | told, and failed to publish |
 * | both correct, field still buried | a surface ignores the offset |
 *
 * The instrument never worked. Opening the reporter means tapping a header
 * button, which blurs the composer, which dismisses the keyboard — and only
 * *then* does the dialog mount and snapshot the environment. So every report
 * records the first row, always, whatever the bug was doing. It cannot
 * distinguish the failure from the act of observing it, and a reporter who
 * followed the instructions on #354 would have handed back a confident false
 * confirmation.
 *
 * ## What is asserted
 *
 * The reporter's own "session details attached" disclosure, which renders
 * `Object.entries` of the very object handed to `api.createBugReport` — so it is
 * what gets *sent*, one render removed. Read through the UI rather than off an
 * intercepted POST deliberately: the app registers a service worker, `page.route`
 * does not see requests it initiates, and an interception that silently misses
 * would let this suite pass while asserting nothing.
 *
 * The keyboard is retracted on blur by {@link retractKeyboardOnBlur}, which
 * models the uncontested half of iOS behaviour and none of the contested half;
 * read its docstring before treating any result here as evidence about #354's
 * underlying cause.
 *
 * The geometry both reports came from: iPhone, 390×797 layout viewport.
 */

test.use({
  viewport: { width: 390, height: 797 },
  hasTouch: true,
  isMobile: true,
});

const COMPOSER = '[data-slot="prompt-input-textarea"]';

/**
 * Opens the reporter and returns the metadata it captured, keyed as the issue
 * table renders it.
 *
 * Stops short of submitting: the payload is fixed the moment the dialog opens,
 * and filing it needs GitHub credentials the e2e server does not have.
 */
async function openReportAndReadMetadata(page: Page): Promise<Record<string, string>> {
  await page.getByRole('button', { name: 'Report a bug' }).click();
  await expect(page.locator('#bug-report-description')).toBeVisible();

  await page.getByRole('button', { name: /Session details attached/ }).click();
  const rows = page.getByTestId('bug-report-metadata-row');
  await expect(rows.first()).toBeVisible();

  return rows.evaluateAll((elements) =>
    Object.fromEntries(
      elements.map((element) => [
        element.getAttribute('data-metadata-key') ?? '',
        element.querySelectorAll('span')[1]?.textContent?.trim() ?? '',
      ]),
    ),
  );
}

test('a report filed with the keyboard up records the keyboard, not its dismissal', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator(COMPOSER)).toBeVisible();

  await retractKeyboardOnBlur(page);
  await focusField(page, COMPOSER);
  await showKeyboard(page);

  const published = await readPublishedKeyboardHeight(page);
  const metadata = await openReportAndReadMetadata(page);

  // The whole point of the three rows. `0px` here would be the reporter
  // measuring its own side effect: the tap that opened it took the keyboard away
  // first.
  expect(metadata.keyboardInset).toBe(`${IOS_KEYBOARD_HEIGHT}px`);
  expect(metadata.visualViewport).toBe(`390×${797 - IOS_KEYBOARD_HEIGHT}`);

  // And it is the *published* variable, not a difference recomputed from the two
  // rows above — read straight off the app for comparison. A recomputed inset
  // would agree here and disagree only in the one case that matters, so pinning
  // it against the real source is what keeps the third row independent.
  expect(metadata.keyboardInset).toBe(published);

  // Layout viewport is the control: iOS never shrinks it, so a report where it
  // differs from the visible one is a report that captured a real keyboard.
  expect(metadata.viewport).toBe('390×797');
  expect(metadata.viewport).not.toBe(metadata.visualViewport);
});

test('a report filed with no keyboard does not invent one', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(COMPOSER)).toBeVisible();

  // The other half of the contract, and the reason the fix cannot simply be "use
  // the last non-zero height ever seen": a report filed with no keyboard must
  // still say so, or the rows stop discriminating in the opposite direction.
  await retractKeyboardOnBlur(page);

  const metadata = await openReportAndReadMetadata(page);

  // `unset`, not `0px`, and the difference is real. Nothing has focused a field
  // or resized the viewport in this run, so `installKeyboardViewportSync` has
  // never written the variable — the publisher has not run, rather than run and
  // returned zero. Collapsing those two into `0px` would throw away the one
  // reading that says "this code path never executed at all".
  expect(metadata.keyboardInset).toBe('unset');
  expect(metadata.viewport).toBe(metadata.visualViewport);
});
