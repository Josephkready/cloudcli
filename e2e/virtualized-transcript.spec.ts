import type { Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { seedLargeConversation, type LargeConversationHandles } from './largeConversationFixture';

/**
 * cloudcli#483 phase 2 — the transcript is windowed with
 * `@tanstack/react-virtual` for anything short of "Load all". These assert the
 * five behaviours the phase was required to preserve, against a real 500+-row
 * conversation and a real Chromium layout engine (the unit/component suite
 * covers the row-count and prevMessage-wiring logic in jsdom, which has no
 * layout engine and cannot answer "does scrolling actually behave right").
 *
 * Mobile composer layout (#477/#485) is not re-tested here: this change does
 * not touch the scroll container's box model, only how its children mount, so
 * the existing `mobile-*` specs staying green is the regression signal for
 * that invariant.
 *
 * Scrolling is driven with `page.mouse.wheel()`, not a raw `scrollTop`
 * assignment: the app's auto-follow suspend/resume logic
 * (`src/components/chat/utils/autoFollow.ts`) reads real wheel/touch signal to
 * tell a deliberate scroll from a programmatic one, and a bare property write
 * doesn't reliably win that race against an active stream's own
 * scroll-to-bottom effect — a real wheel event is both more realistic and the
 * one that actually exercises the suspend path.
 */

async function wheelUp(page: Page, container: Locator, deltaY: number) {
  const box = await container.boundingBox();
  if (!box) throw new Error('scroll container has no layout box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -deltaY);
}

/** Scrolls up and confirms the app actually registered it as a deliberate
 * scroll (the "Scroll to bottom" affordance appears) before moving on,
 * retrying the wheel itself a couple of times — an occasional wheel event
 * that Chromium doesn't deliver is test flakiness, not product behavior. */
async function scrollUpUntilSuspended(page: Page, container: Locator, deltaY: number) {
  const scrollToBottomButton = page.getByRole('button', { name: 'Scroll to bottom' });
  for (let attempt = 0; attempt < 3; attempt++) {
    await wheelUp(page, container, deltaY);
    try {
      await expect(scrollToBottomButton).toBeVisible({ timeout: 2_000 });
      return;
    } catch {
      // try again
    }
  }
  await expect(scrollToBottomButton).toBeVisible();
}

/** The layout can take an extra frame or two to settle after an async resize
 * (dynamic remeasurement, a diagram finishing its own internal layout) —
 * waits for two consecutive reads, spaced apart, to agree before trusting the
 * value, rather than trusting whichever single frame happened to be sampled. */
async function stableY(locator: Locator): Promise<number> {
  let previous: number | null = null;
  for (let i = 0; i < 10; i++) {
    const box = await locator.boundingBox();
    const y = box?.y ?? null;
    if (y !== null && previous !== null && Math.abs(y - previous) < 1) {
      return y;
    }
    previous = y;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (previous === null) throw new Error('locator never had a layout box');
  return previous;
}

async function scrollMetrics(container: Locator) {
  return container.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    mounted: el.querySelectorAll('.chat-message').length,
  }));
}

/** Repeatedly scrolls to the top to trigger `loadOlderMessages` pages until at
 * least `minMounted` rows have ever been mounted, or gives up after `attempts`
 * tries. Mirrors how a reader actually accumulates a long loaded history:
 * scroll up, wait for the page to land, scroll up again. */
async function loadHistoryUntil(page: Page, container: Locator, minLoaded: number, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const before = await scrollMetrics(container);
    if (before.scrollTop > 20) {
      await wheelUp(page, container, 4000);
      await page.waitForTimeout(250);
    }
    await wheelUp(page, container, 4000);
    await page.waitForTimeout(300);
    const after = await scrollMetrics(container);
    if (after.scrollHeight >= minLoaded * 60) return after;
  }
  return scrollMetrics(container);
}

let fixture: LargeConversationHandles;

// A 520-row session opens, pages, and (in the Load-all case) flat-renders
// every row under whatever load the CI host is under — the first gate run
// blew the default 45s budget on exactly those steps while sharing the host
// with a dozen other CI lanes. The waits below are generous for the same
// reason; none of them are load-bearing for what is being asserted.
test.setTimeout(120_000);

test.beforeEach(async ({ server }) => {
  fixture = seedLargeConversation(server.home, server.projectPath);
});

test('bounds mounted rows to a small window even once hundreds of messages are loaded', async ({ page }) => {
  await page.goto(`/session/${fixture.sessionId}`);

  const container = page.locator('.chat-messages-pane');
  await expect(container).toBeVisible();
  await expect(page.getByText(fixture.lastMessageText)).toBeVisible({ timeout: 30_000 });

  // Nowhere near loaded yet, let alone rendered.
  await expect(page.getByText(fixture.firstMessageText)).toHaveCount(0);

  // Scroll up through history repeatedly, the way a reader actually reaches a
  // long way back — this is what makes the "windowed, not everything mounted"
  // claim meaningful: a fresh session open alone only loads ~20 rows, too few
  // for virtualization to visibly matter.
  const metrics = await loadHistoryUntil(page, container, 200);
  expect(metrics.scrollHeight).toBeGreaterThan(200 * 40);
  expect(metrics.mounted).toBeLessThan(120);
});

test('auto-follows a streamed reply into an already-long conversation', async ({ page }) => {
  await page.goto(`/session/${fixture.sessionId}`);
  await expect(page.getByText(fixture.lastMessageText)).toBeVisible({ timeout: 30_000 });

  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await composer.fill('one more turn, please');
  await page.getByRole('button', { name: 'Send' }).click();

  const assistant = page.locator('.chat-message.assistant').last();
  await expect(assistant.getByText('the mock provider.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);

  // Pinned to the bottom, not just "the new text exists somewhere in the DOM".
  // Polled rather than read once: the virtualizer's dynamic remeasurement of
  // the just-streamed reply can land a frame or two after the text itself
  // becomes visible.
  const container = page.locator('.chat-messages-pane');
  await expect.poll(async () => {
    const m = await scrollMetrics(container);
    return m.scrollHeight - m.scrollTop - m.clientHeight;
  }, { timeout: 5_000 }).toBeLessThan(40);

  // The scroll-to-bottom affordance only shows once the reader has scrolled
  // away from the tail — its absence here is the app's own signal that
  // auto-follow, not a manual scroll, is what landed the view at the bottom.
  await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toHaveCount(0);
});

test('stops following once the reader scrolls up, and does not snap back', async ({ page }) => {
  await page.goto(`/session/${fixture.sessionId}`);
  await expect(page.getByText(fixture.lastMessageText)).toBeVisible({ timeout: 30_000 });

  const container = page.locator('.chat-messages-pane');
  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await composer.fill('another turn while I scroll away');
  await page.getByRole('button', { name: 'Send' }).click();

  // Scroll up mid-turn, before the reply settles.
  await scrollUpUntilSuspended(page, container, 6000);

  const distanceFromBottomAfterScrollUp = await container.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
  );
  expect(distanceFromBottomAfterScrollUp).toBeGreaterThan(200);

  // Let the run finish.
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(300);

  // A follow that "won" would have forced the view back down to the tail
  // (distance-from-bottom near 0). Compared against distance, not the raw
  // `scrollTop` value, so legitimate anchor-compensation as rows above get
  // their real (vs. estimated) height measured — which shifts `scrollTop` by
  // design, not by bug — doesn't read as a false failure here.
  const distanceFromBottomAfterCompletion = await container.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
  );
  expect(distanceFromBottomAfterCompletion).toBeGreaterThan(200);
  await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible();
});

test('an off-screen diagram finishing its async layout does not shift the reader\'s current view', async ({ page }) => {
  await page.goto(`/session/${fixture.sessionId}`);
  await expect(page.getByText(fixture.lastMessageText)).toBeVisible({ timeout: 30_000 });
  const anchor = page.getByText(fixture.afterMermaidMessageText);
  await expect(anchor).toBeVisible({ timeout: 30_000 });

  // Pin the anchor to the TOP of the viewport, deterministically pushing the
  // mermaid message (which sits right before it) above the fold — a fixed
  // pixel wheel delta is at the mercy of the browser's wheel-to-scroll ratio
  // and can leave the anchor uncomfortably close to the render-window edge,
  // which is what made this flaky before landing on `scrollIntoView`.
  await anchor.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(anchor).toBeVisible();

  const anchorYBeforeDiagram = await stableY(anchor);

  const diagram = page.locator('[data-testid="mermaid-diagram"] svg');
  await expect(diagram).toBeVisible({ timeout: 30_000 });

  const anchorYAfterDiagram = await stableY(anchor);
  expect(Math.abs(anchorYAfterDiagram - anchorYBeforeDiagram)).toBeLessThan(12);
});

test('"Load all" still mounts every message, preserving the search-to-message affordance', async ({ page }) => {
  await page.goto(`/session/${fixture.sessionId}`);
  await expect(page.getByText(fixture.lastMessageText)).toBeVisible({ timeout: 30_000 });

  const container = page.locator('.chat-messages-pane');
  // The "Load all" overlay appears when the reader reaches the top and fades
  // out again 2.5s later, so under load a single attempt can miss its window.
  // Reach the top with a deliberately overshooting delta (the trigger is an
  // *absolute* `scrollTop < 100`, not "scrolled up by some amount"), try to
  // click within the window, and if it faded first scroll back down past the
  // re-arm threshold (`scrollTop >= 100`) and go again.
  const loadAllButton = page.getByRole('button', { name: /Load all messages/ });
  let clicked = false;
  for (let attempt = 0; attempt < 6 && !clicked; attempt++) {
    await wheelUp(page, container, 50_000);
    try {
      await loadAllButton.click({ timeout: 2_000 });
      clicked = true;
    } catch {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
    }
  }
  expect(clicked).toBe(true);

  // Fetching and flat-rendering all 520 rows is the slowest thing in this file.
  await expect(page.getByText(fixture.firstMessageText)).toBeVisible({ timeout: 60_000 });

  const mountedAfterLoadAll = (await scrollMetrics(container)).mounted;
  expect(mountedAfterLoadAll).toBeGreaterThan(400);
});
