import type { Page, Route } from '@playwright/test';

import { test, expect } from './fixtures';

/**
 * #527 - "Hitting send ... takes a few seconds before message sent and UI changes".
 *
 * The first message of a brand-new chat cannot go out until the server has
 * allocated the session id (POST /api/providers/sessions). The bubble and the
 * composer reset used to wait for that round trip as well, so on a slow or cold
 * connection - the installed iPhone PWA coming back from the background - the
 * tap on Send looked ignored for as long as the request took. On an existing
 * conversation the same send renders in tens of milliseconds, which is why a
 * profile of that path found nothing.
 *
 * These tests hold the session-create request open, so the round trip is as slow
 * as the test wants, and assert on what the user sees in the meantime.
 */

const COMPOSER = '[data-slot="prompt-input-textarea"]';

// The app's service worker would otherwise issue these fetches itself, and
// WebKit does not route service-worker requests through `page.route`, so the
// hold below would silently never engage there.
test.use({ serviceWorkers: 'block' });

/** Intercepts the next session-create POST and holds it until `release` is called. */
async function holdSessionCreate(page: Page) {
  let held: Route | null = null;
  let arrived: () => void = () => {};
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route('**/api/providers/sessions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    held = route;
    arrived();
  });
  return {
    arrival,
    route: () => {
      if (!held) throw new Error('session-create request was never made');
      return held;
    },
  };
}

async function sendFirstMessage(page: Page, text: string) {
  await page.goto('/');
  const composer = page.locator(COMPOSER);
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

test('the first send of a new chat shows the message before the session round trip ends', async ({ page }) => {
  const hold = await holdSessionCreate(page);
  const text = 'first message while the network is slow';
  await sendFirstMessage(page, text);
  await hold.arrival;

  // The request is still in flight: the user must already see the send happen.
  await expect(page.locator('.chat-message.user').getByText(text)).toBeVisible();
  await expect(page.locator(COMPOSER)).toHaveValue('');

  await hold.route().continue();

  // The round trip completes: one bubble (not two), the reply streams in, and
  // the chat moved to its session URL as before.
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/);
  await expect(
    page.locator('.chat-message.assistant').getByText('the mock provider.', { exact: false }).first(),
  ).toBeVisible();
  await expect(page.locator('.chat-message.user').getByText(text)).toHaveCount(1);
});

test('a failed session start gives the draft back instead of losing it', async ({ page }) => {
  const hold = await holdSessionCreate(page);
  const text = 'this one should come back';
  await sendFirstMessage(page, text);
  await hold.arrival;

  await hold.route().fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' });

  await expect(page.getByText('Failed to start a new session', { exact: false })).toBeVisible();
  await expect(page.locator(COMPOSER)).toHaveValue(text);
  await expect(page.locator('.chat-message.user').getByText(text)).toHaveCount(0);
});
