import type { Locator, Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { MOCK_HOLD_RUN_SENTINEL } from '../server/routes/mock-agent-fixtures.js';
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
 * keyboard and inserted nothing. The fix hides the button while the list is
 * open, rather than re-ranking either layer.
 *
 * The button only exists while the reader is scrolled up, so the spec scrolls
 * up first. It then asks the browser, not a model of it, what sits under the
 * row's centre, and finally clicks there by coordinate, so the click lands on
 * whatever really paints on top.
 *
 * The second test guards the neighbouring layer. The same shell also holds the
 * activity indicator and its Stop button, directly under the button's strip.
 * Any fix that lifts the shell to rescue the list also lifts Stop over the
 * button during a running turn, and a tap meant for "scroll to bottom" would
 * abort the run instead.
 */

const MENTION_FILE = 'mention-target.txt';

let fixture: LargeConversationHandles;

/** Scrolls the pane away from the newest message until the arrow shows. */
async function scrollUntilArrowShows(page: Page): Promise<Locator> {
  const pane = page.locator('.chat-messages-pane');
  await expect(pane).toBeVisible();
  const scrollToBottom = page.getByRole('button', { name: 'Scroll to bottom' });
  // Repeated because landing and paging can re-pin the pane while history settles.
  // The wheel event is what makes this the *reader's* scroll: a bare `scrollTop`
  // write is indistinguishable from the app moving itself, which no longer stops
  // auto-follow (#540), so the next resize would pull the pane straight back down.
  await expect(async () => {
    await pane.evaluate((el) => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1500, bubbles: true }));
      el.scrollTop = Math.max(0, el.scrollTop - 1500);
    });
    await expect(scrollToBottom).toBeVisible({ timeout: 1_000 });
    // And still there a moment later. Sending schedules a scroll to the bottom
    // 100ms out, and the landing pass re-pins for up to a second after opening;
    // a read-up inside either window shows the button only to lose it again.
    await page.waitForTimeout(500);
    await expect(scrollToBottom).toBeVisible({ timeout: 100 });
  }).toPass({ timeout: 15_000 });
  return scrollToBottom;
}

test.beforeEach(async ({ server }) => {
  writeFileSync(path.join(server.projectPath, MENTION_FILE), 'hello\n');
  fixture = seedLargeConversation(server.home, server.projectPath);
});

test('the centre of an @ file suggestion is the suggestion, not the scroll-to-bottom button', async ({ page }) => {
  await page.goto(`/session/${fixture.sessionId}`);

  const scrollToBottom = await scrollUntilArrowShows(page);

  const composer = page.locator('textarea').first();
  await composer.click();
  await composer.pressSequentially('@');

  // The row is the clickable element holding the file name.
  const option = page.locator('.cursor-pointer', { hasText: MENTION_FILE }).first();
  await expect(option).toBeVisible();
  // The reader is still scrolled up (the button showed a moment ago), so the
  // only reason it is gone is that it stands aside for the open list.
  await expect(scrollToBottom).toBeHidden();

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
  // The list has closed and the reader never scrolled, so the button is back.
  await expect(scrollToBottom).toBeVisible();
});

test('during a running turn the scroll-to-bottom button paints above the Stop button', async ({ page }) => {
  await page.goto(`/session/${fixture.sessionId}`);

  const composer = page.locator('textarea').first();
  await composer.click();
  await composer.fill(`keep this run going ${MOCK_HOLD_RUN_SENTINEL}`);
  await page.getByRole('button', { name: 'Send' }).click();

  // The run is in progress: the activity indicator shows its Stop button.
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stop.first()).toBeVisible();

  const scrollToBottom = await scrollUntilArrowShows(page);
  // Still running, or the test proves nothing.
  await expect(stop.first()).toBeVisible();

  const box = await scrollToBottom.boundingBox();
  if (!box) throw new Error('scroll-to-bottom button has no layout box');
  // Centre plus four points just inside the edges: a partial overlap by the
  // indicator row would still steal taps near the button's rim.
  const points = [
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + 3, y: box.y + box.height / 2 },
    { x: box.x + box.width - 3, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: box.y + 3 },
    { x: box.x + box.width / 2, y: box.y + box.height - 3 },
  ];
  const hits = await scrollToBottom.evaluate((button, pts) => pts.map((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    return {
      isArrow: button.contains(el),
      isStop: Boolean(el?.closest('button[aria-label="Stop"]')),
    };
  }), points);
  for (const hit of hits) {
    expect(hit.isStop, 'the Stop button paints over the scroll-to-bottom button').toBe(false);
    expect(hit.isArrow, 'something paints over the scroll-to-bottom button').toBe(true);
  }

  // A real tap on the arrow scrolls down and leaves the run going.
  await page.mouse.click(points[0].x, points[0].y);
  await expect(scrollToBottom).toBeHidden();
  await expect(stop.first()).toBeVisible();
});
