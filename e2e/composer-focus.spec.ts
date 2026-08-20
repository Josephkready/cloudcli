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

/**
 * The two ways to send, which take genuinely different code paths.
 *
 * A <textarea> never triggers implicit form submission, so Enter does NOT reach
 * the form's `onSubmit` — `handleKeyDown` calls the composer state's
 * `handleSubmit` directly. A fix applied only to the view's `onSubmit` prop
 * would repair the click and leave the primary desktop gesture broken, and a
 * suite that only clicks would not notice.
 */
type SendGesture = 'click' | 'enter';

async function completeOneTurn(
  page: import('@playwright/test').Page,
  message: string,
  gesture: SendGesture = 'click',
) {
  const composer = page.locator(COMPOSER);
  await composer.click();
  await composer.fill(message);

  if (gesture === 'enter') {
    await composer.press('Enter');
  } else {
    await page.getByRole('button', { name: 'Send' }).click();
  }

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

test('composer keeps focus when sending with Enter', async ({ page }, testInfo) => {
  // Desktop only, and not for convenience: on a touch layout plain Enter inserts
  // a NEWLINE rather than sending (resolveEnterKeyAction, so the on-screen
  // keyboard's Return key does not fire the message). There is no Enter-to-send
  // path on mobile to assert about.
  test.skip(
    testInfo.project.name !== 'chromium',
    'plain Enter inserts a newline on touch layouts by design',
  );

  /*
   * Enter takes a different path from the click: a <textarea> never triggers
   * implicit form submission, so `handleKeyDown` calls the composer state's
   * `handleSubmit` directly and the form's `onSubmit` — where the fix lives — is
   * never reached.
   *
   * This path was nonetheless never broken, which is worth recording because it
   * looks like it should have been. The bug needs focus to be ON the submit
   * button when it becomes disabled; pressing Enter leaves focus in the textarea
   * the whole time, so the disable has nothing to evict. Verified against
   * unfixed `origin/main`: the two click tests fail there and this one passes.
   *
   * So this is a guard, not a reproduction — it pins a path that a "tidier" fix
   * could break. Specifically, moving the focus restore into the hook's
   * `handleSubmit` to "cover every call site" would be wrong: that function also
   * has three PROGRAMMATIC callers (queue drain, slash-command dispatch, and
   * voice send-on-transcript), all on a setTimeout outside any user gesture.
   * Focusing there would steal focus — and pop the on-screen keyboard — while
   * the user is reading a reply.
   */
  await page.goto('/');
  await expect(page.locator(COMPOSER)).toBeVisible();

  await completeOneTurn(page, 'sent with the enter key', 'enter');

  expect(await focusDescription(page)).toMatchObject({
    tag: 'TEXTAREA',
    slot: 'prompt-input-textarea',
  });

  await completeOneTurn(page, 'second one with enter too', 'enter');

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
