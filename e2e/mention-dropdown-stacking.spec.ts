import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures';
import { seedLargeConversation, type LargeConversationHandles } from './largeConversationFixture';

/**
 * cloudcli#542 — tapping the middle of an `@` file suggestion hit the
 * "Scroll to bottom" button instead of the suggestion.
 *
 * The suggestion list is `z-50`, but it renders inside `.chat-composer-shell`,
 * whose `contain: layout` makes the shell its own stacking context. Its `z-50`
 * therefore only ranked it *inside* the shell, and the scroll-to-bottom
 * wrapper (`z-20`, a sibling of the shell) painted over the middle of the first
 * row. Tapping there scrolled the transcript to the bottom, dismissed the
 * keyboard and inserted nothing.
 *
 * The button only exists while the reader is scrolled up, so the spec scrolls
 * up first. It then asks the browser, not a model of it, what sits under the
 * row's centre, and finally clicks there by coordinate, so the click lands on
 * whatever really paints on top.
 */

const MENTION_FILE = 'mention-target.txt';

let fixture: LargeConversationHandles;

test.beforeEach(async ({ server }) => {
  writeFileSync(path.join(server.projectPath, MENTION_FILE), 'hello\n');
  fixture = seedLargeConversation(server.home, server.projectPath);
});

test('the centre of an @ file suggestion is the suggestion, not the scroll-to-bottom button', async ({ page }) => {
  await page.goto(`/session/${fixture.sessionId}`);

  const pane = page.locator('.chat-messages-pane');
  await expect(pane).toBeVisible();
  const scrollToBottom = page.getByRole('button', { name: 'Scroll to bottom' });

  // Scroll away from the newest message until the button appears. Repeated
  // because landing and paging can re-pin the pane while history settles.
  await expect(async () => {
    await pane.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 1500); });
    await expect(scrollToBottom).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  const composer = page.locator('textarea').first();
  await composer.click();
  await composer.pressSequentially('@');

  // The row is the clickable element holding the file name.
  const option = page.locator('.cursor-pointer', { hasText: MENTION_FILE }).first();
  await expect(option).toBeVisible();
  // The button must still be showing, or the test proves nothing.
  await expect(scrollToBottom).toBeVisible();

  const box = await option.boundingBox();
  if (!box) throw new Error('suggestion row has no layout box');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  const topmostIsOption = await option.evaluate(
    (el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
    centre,
  );
  expect(topmostIsOption, 'the scroll-to-bottom button paints over the suggestion').toBe(true);

  await page.mouse.click(centre.x, centre.y);
  await expect(composer).toHaveValue(new RegExp(MENTION_FILE.replace('.', '\\.')));
});
