import { test, expect } from './fixtures';

/**
 * #367 — the composer must still hold focus once a send completes.
 *
 * The mechanism, traced in a real browser rather than assumed: clicking the
 * submit button focuses it (ordinary browser behaviour), and sending clears the
 * input. When the run finishes, the button's `disabled` prop evaluates
 * `!input.trim()` — now true — and a browser blurs a control the instant it
 * becomes disabled. Focus falls to <body>.
 *
 * The button is NOT unmounted, which is what the issue originally guessed. It is
 * a single persistent element whose label flips Send/Stop, it fires a genuine
 * focusout while still connected to the DOM, and it reads `disabled: true` on
 * the following frame. A test asserting "the button is still mounted" would
 * therefore have passed against the bug.
 *
 * Runs on WebKit and mobile Chrome as well as desktop: on a phone this is what
 * closes the on-screen keyboard between every turn, and WebKit is the only
 * engine here that can speak to an iPhone report.
 */

const COMPOSER = '[data-slot="prompt-input-textarea"]';

async function completeOneTurn(page: import('@playwright/test').Page, message: string) {
  const composer = page.locator(COMPOSER);
  await composer.click();
  await composer.fill(message);
  await page.getByRole('button', { name: 'Send' }).click();

  // Prove the turn really ran, so we are asserting on a completed send rather
  // than on a moment before the state transition that causes the bug.
  await expect(
    page.locator('.chat-message.assistant').getByText('the mock provider.', { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
}

/** What currently holds focus, described well enough to make a failure readable. */
function focusDescription(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? 'null',
      slot: el?.getAttribute?.('data-slot') ?? null,
      label: el?.getAttribute?.('aria-label') ?? null,
    };
  });
}

test('composer keeps focus after a send completes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(COMPOSER)).toBeVisible();

  // First send, which also navigates / -> /session/:id.
  await completeOneTurn(page, 'first message');

  expect(await focusDescription(page)).toMatchObject({
    tag: 'TEXTAREA',
    slot: 'prompt-input-textarea',
  });

  // Second send, inside the live session with no navigation — the issue reports
  // this happening on *every* send, so one turn is not enough to pin it.
  await completeOneTurn(page, 'second message');

  expect(await focusDescription(page)).toMatchObject({
    tag: 'TEXTAREA',
    slot: 'prompt-input-textarea',
  });
});

test('the submit button never holds focus once the run ends', async ({ page }) => {
  // The specific end state that broke: focus parked on a control that is about
  // to be disabled. Asserting the textarea has focus (above) and that the button
  // does not (here) are different claims — a third element could take focus and
  // only one of the two tests would catch it.
  await page.goto('/');
  await expect(page.locator(COMPOSER)).toBeVisible();

  await completeOneTurn(page, 'focus should not stay on the button');

  const state = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
    return {
      focusIsSubmit: !!submit && submit === el,
      focusIsBody: el === document.body,
      submitDisabled: submit ? submit.disabled : null,
    };
  });

  // The disabled submit is exactly the condition that evicts focus, so if this
  // ever stops being true the test above is no longer covering the real bug.
  expect(state.submitDisabled).toBe(true);
  expect(state.focusIsSubmit).toBe(false);
  expect(state.focusIsBody).toBe(false);
});
