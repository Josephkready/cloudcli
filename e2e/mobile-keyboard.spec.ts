import type { Page } from '@playwright/test';

import { test, expect } from './fixtures';
import {
  IOS_KEYBOARD_HEIGHT,
  expectClearsKeyboard,
  hideKeyboard,
  keyboardLine,
  showKeyboard,
} from './keyboard';

/**
 * Every text field in the app must stay visible while the soft keyboard is up.
 *
 * Reported three times — #346, #354, #357 — and twice declared fixed on the
 * strength of a node test that never laid out a pixel. So this is written as a
 * **sweep** rather than a case: each surface that can hold a text field is one
 * row in {@link SURFACES}, and the same assertion runs against all of them. A
 * new modal with an input is one entry, and forgetting to add one is the only
 * way to regress silently.
 *
 * The geometry both reports came from: iPhone, 390×797 layout viewport.
 */

test.use({
  viewport: { width: 390, height: 797 },
  hasTouch: true,
  isMobile: true,
});

type Surface = {
  /** Name as it appears in the test title. */
  name: string;
  /** Issue this surface was reported in, for the failure message. */
  issue: string;
  /** Navigates to and opens the surface, leaving its text field on screen. */
  open: (page: Page) => Promise<void>;
  /** The text field the user types into. */
  field: (page: Page) => ReturnType<Page['locator']>;
};

const SURFACES: Surface[] = [
  {
    name: 'chat composer',
    issue: '#354',
    open: async (page) => {
      await page.goto('/');
      await expect(page.locator('[data-slot="prompt-input-textarea"]')).toBeVisible();
    },
    field: (page) => page.locator('[data-slot="prompt-input-textarea"]'),
  },
  {
    // Distinct from the composer above, and worth its own row: #354 was reported
    // from `/session/:id`, not `/`. In a live session the composer sits under a
    // populated, scrolling transcript rather than an empty state, so its
    // enclosing layout is not the one the landing page exercises.
    name: 'chat composer in a live session',
    issue: '#354',
    open: async (page) => {
      await page.goto('/');
      const composer = page.locator('[data-slot="prompt-input-textarea"]');
      await expect(composer).toBeVisible();
      await composer.fill('hello from the keyboard sweep');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/);
      await expect(page.locator('.chat-message.assistant').first()).toBeVisible();
    },
    field: (page) => page.locator('[data-slot="prompt-input-textarea"]'),
  },
  {
    name: 'bug report dialog',
    issue: '#357',
    open: async (page) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Report a bug' }).click();
      await expect(page.locator('#bug-report-description')).toBeVisible();
    },
    field: (page) => page.locator('#bug-report-description'),
  },
];

for (const surface of SURFACES) {
  test(`${surface.name} stays clear of the keyboard (${surface.issue})`, async ({ page }) => {
    await surface.open(page);

    const field = surface.field(page);
    await field.click();
    await showKeyboard(page);

    await expectClearsKeyboard(page, field);
  });
}

test('the shell returns to full height once the keyboard closes', async ({ page }) => {
  await page.goto('/');
  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();

  const restingBottom = await composer.boundingBox().then((box) => box!.y + box!.height);

  await showKeyboard(page);
  await expectClearsKeyboard(page, composer);

  await hideKeyboard(page);
  // Guards the obvious over-correction: a surface that lifts and never comes
  // back down leaves a keyboard-sized gap under the composer forever.
  const afterBottom = await composer.boundingBox().then((box) => box!.y + box!.height);
  expect(Math.abs(afterBottom - restingBottom)).toBeLessThanOrEqual(2);
});

test('both fields in the #357 sequence clear the keyboard', async ({ page }) => {
  // The sequence in #357: "switching between report a bug and the conversation
  // input text box". Asserted here as pure geometry — each field is focused
  // *before* the height is published, so the app's own publisher samples and
  // republishes the same value rather than fighting the test.
  //
  // The other half of this sequence — whether the height survives the second
  // focus at all — is a publisher question and lives in
  // mobile-keyboard-publisher.spec.ts. Asserting it here measured the publisher
  // through the consumer and failed for a reason that had nothing to do with
  // either surface's layout.
  await page.goto('/');

  await page.getByRole('button', { name: 'Report a bug' }).click();
  const reportField = page.locator('#bug-report-description');
  await expect(reportField).toBeVisible();
  await reportField.click();
  await showKeyboard(page);
  await expectClearsKeyboard(page, reportField);

  await page.keyboard.press('Escape');

  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();
  await composer.click();
  await showKeyboard(page);
  await expectClearsKeyboard(page, composer);

  const line = await keyboardLine(page, IOS_KEYBOARD_HEIGHT);
  expect(line).toBeGreaterThan(0);
});
