import type { Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { seedLargeConversation, type LargeConversationHandles } from './largeConversationFixture';

/**
 * cloudcli#483 phase 2 — the transcript is windowed with
 * `@tanstack/react-virtual` for every view except an explicit "show the whole
 * thread" request, which now only the in-conversation search jump makes. These
 * assert the behaviours the phase was required to preserve, against a real 500+-row
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

// A 520-row session opens, pages, and (in the search-jump case) flat-renders
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
  // becomes visible. 20s, not this file's usual 5s default: the mechanism
  // being asserted here (a ResizeObserver callback + a 50ms setTimeout, see
  // `useChatSessionState.ts`) runs on the browser's own timer/rAF queue, and
  // a shared, heavily-loaded CI host can starve those for several seconds at
  // a time (the gate run that caught this was 20+ minutes into the sibling
  // `tests` lane at the moment this ran) — every other assertion in this file
  // was already widened for exactly that reason (see the file-level
  // `test.setTimeout`); this one was missed the first time.
  const container = page.locator('.chat-messages-pane');
  await expect.poll(async () => {
    const m = await scrollMetrics(container);
    return m.scrollHeight - m.scrollTop - m.clientHeight;
  }, { timeout: 20_000 }).toBeLessThan(40);

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

test('history arrives by scrolling alone — there is no "load all" control to press', async ({ page }) => {
  await page.goto(`/session/${fixture.sessionId}`);
  await expect(page.getByText(fixture.lastMessageText)).toBeVisible({ timeout: 30_000 });

  const container = page.locator('.chat-messages-pane');

  // The affordances this replaced: a "Load all messages (N)" pill that appeared
  // on nearing the top and faded 2.5s later, a "Showing N of M · scroll to
  // load" banner, and a "Load earlier messages" link. All three lived *in* the
  // scrolled content and mounted or unmounted mid-scroll, shoving the
  // transcript under the reader (cloudcli#495) — and none of them offered
  // anything scrolling does not already do.
  const removedControls = page.getByRole('button', { name: /load all|load earlier/i });

  const before = await scrollMetrics(container);
  const after = await loadHistoryUntil(page, container, 200);

  // Scrolling alone pulled in far more history than the initial page...
  expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight * 2);
  // ...while the pane stayed windowed rather than mounting the whole thread...
  expect(after.mounted).toBeLessThan(120);
  // ...and at no point was there a control to press.
  await expect(removedControls).toHaveCount(0);
});

test('a cross-conversation search jump lands on and highlights the target message', async ({ page }) => {
  // Deliberately starts at the app root, not the session directly: a search
  // jump has to work from anywhere, and this is the one path in the app that
  // still finds a message via a real DOM query
  // (`useChatSessionState.ts`'s `searchTarget` effect) rather than the
  // virtualized window — the thing the review of this PR flagged the earlier
  // version of this file as claiming to cover without actually exercising.
  await page.goto('/');

  await expect(page.getByRole('button', { name: /search chats/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /search chats/i }).click();

  const searchInput = page.getByPlaceholder(/search in conversations/i).and(page.locator(':visible'));
  await expect(searchInput).toBeFocused();
  await searchInput.fill(fixture.searchTargetMessageText);

  const resultButton = page.getByRole('button').filter({ hasText: fixture.searchTargetMessageText });
  await expect(resultButton).toBeVisible({ timeout: 30_000 });
  await resultButton.click();

  // Landing here forces the flat fetch+render of the whole thread (the search
  // flow cannot know in advance whether the target row sits inside the
  // paginated window). Since the "Load all" control was removed, this is the
  // only path left that requests it, which makes this test the sole coverage
  // of that render mode end to end. What this test adds on top is the actual jump-and-highlight this
  // test title promises: the target row must both render and carry the
  // `search-highlight-flash` class the app applies for ~4s once it locates
  // the match by DOM query.
  const target = page.locator('.chat-message', { hasText: fixture.searchTargetMessageText });
  await expect(target).toHaveClass(/search-highlight-flash/, { timeout: 60_000 });

  // And that the render really did go flat, not merely wide enough to reach
  // this particular row. Finding row 201 of 520 only proves a window of ~319+,
  // so a regression that set some large-but-finite `visibleMessageCount`
  // instead of `Infinity` would satisfy the highlight assertion above and
  // nothing else. The deleted "Load all" test used to pin this with its own
  // `mounted > 400`; since this is now the only path that requests the flat
  // render, that assertion has to live here or nowhere.
  const mounted = (await scrollMetrics(page.locator('.chat-messages-pane'))).mounted;
  expect(mounted).toBeGreaterThan(400);
});
