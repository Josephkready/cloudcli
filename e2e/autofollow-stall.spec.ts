import type { Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { seedLargeConversation, type LargeConversationHandles } from './largeConversationFixture';

/**
 * cloudcli#540 — while a reply streams, the pane stops following it and no
 * scroll-to-bottom button appears, so the newest text slides under the composer
 * with nothing to say it is there.
 *
 * The trigger is the app itself. The transcript is virtualized, and the
 * virtualizer writes `scrollTop` whenever a re-measured row turns out a few
 * pixels off its estimate. That write fires an ordinary `scroll` event, and the
 * follow logic read "moved up 7px, now 7px from the bottom" as the reader taking
 * control. Following then stayed off for the rest of the run, and because the
 * button only appears 50px from the bottom — and was only recomputed on scroll
 * events, which a growing pane under a still reader never fires — it never came.
 *
 * Measured on a real phone before this was written: pinned at send, then 7px,
 * 35px, … 175px from the bottom over a 30-chunk reply, with no button at all.
 *
 * The nudge here is a bare `scrollTop` write with no input around it, which is
 * exactly what the virtualizer does. The reply is held back by the mock's
 * `hold:` prefix so the run is live, and the nudge lands, before it arrives.
 */

const REPLY_LINES = 24;
const REPLY_MARKER = 'autofollow-reply-end';

/** A reply tall enough that failing to follow it leaves it far off-screen. */
function tallReply(): string {
  const lines = Array.from({ length: REPLY_LINES }, (_, i) => `Reply paragraph ${i + 1}.`);
  return `${lines.join('\n\n')}\n\n${REPLY_MARKER}`;
}

async function distanceFromBottom(container: Locator): Promise<number> {
  return container.evaluate((el) => Math.max(el.scrollHeight - el.scrollTop - el.clientHeight, 0));
}

async function openSeededConversation(page: Page, fixture: LargeConversationHandles): Promise<Locator> {
  await page.goto(`/session/${fixture.sessionId}`);
  const container = page.locator('.chat-messages-pane');
  await expect(container).toBeVisible();
  await expect(page.getByText(fixture.lastMessageText)).toBeVisible({ timeout: 60_000 });
  // Let the landing pass and lazy row measurement settle at the bottom. Under
  // gate load the landing occasionally stops short of it (a separate, known
  // quirk of opening a long conversation), sometimes inside the band where no
  // button shows, so nudge it there directly: this spec is about what happens
  // once pinned, not about the landing.
  await expect.poll(async () => {
    const distance = await distanceFromBottom(container);
    if (distance > 4) {
      await container.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    }
    return distance;
  }, { timeout: 15_000 }).toBeLessThanOrEqual(4);
  // And then let the landing pass *finish*. For a while after opening it keeps
  // re-pinning the pane to the bottom through any reflow, which would mask the
  // stall under test (on the unfixed code this passed 3 runs in 4 without it).
  await page.waitForTimeout(2_000);
  return container;
}

/**
 * The reply's closing line, inside the assistant bubble only. The prompt carries
 * the same text (`echo:` answers with it), so an unscoped match finds the user
 * bubble the instant the message is sent, long before the reply exists.
 */
function replyEnd(page: Page): Locator {
  return page.locator('.chat-message.assistant').getByText(REPLY_MARKER);
}

async function sendHeldReply(page: Page, holdMs: number): Promise<void> {
  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await composer.fill(`hold:${holdMs}:echo:${tallReply()}`);
  await page.getByRole('button', { name: 'Send' }).click();
}

let fixture: LargeConversationHandles;

test.beforeEach(({ server }) => {
  fixture = seedLargeConversation(server.home, server.projectPath);
});

test('an app-originated scroll nudge does not stop the pane following the reply', async ({ page }) => {
  const container = await openSeededConversation(page, fixture);

  await sendHeldReply(page, 2_500);
  // Sending pins the pane to the bottom and re-arms following. Wait out the
  // send's own follow (a deferred write, then the new row's measurement) so
  // the nudge below is not simply undone by it — the run is still live, its
  // reply held back for seconds yet.
  await page.waitForTimeout(700);
  await expect.poll(() => distanceFromBottom(container)).toBeLessThanOrEqual(4);

  // What the virtualizer does when a row re-measures a few pixels short: a bare
  // `scrollTop` write, no touch, wheel or key anywhere near it.
  await container.evaluate((el) => {
    el.scrollTop -= 7;
  });
  await page.waitForTimeout(300);

  const end = replyEnd(page);
  await expect(end).toBeAttached({ timeout: 15_000 });

  // The reply that lands after the nudge must still be followed.
  await expect.poll(() => distanceFromBottom(container), { timeout: 5_000 }).toBeLessThanOrEqual(4);
  await expect(end).toBeInViewport();
});

test('content growing under a reader who scrolled up surfaces the scroll-to-bottom button', async ({ page }) => {
  const container = await openSeededConversation(page, fixture);
  const scrollButton = page.getByRole('button', { name: 'Scroll to bottom' });

  // A deliberate, short read-up: it suspends following but stays inside the
  // 50px band, so no button yet — correctly. Driven as a wheel event plus an
  // exact 20px move rather than `mouse.wheel`, whose real step varied from
  // 20px to 330px between runs and sometimes cleared the band on its own.
  await container.evaluate((el) => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    el.scrollTop -= 20;
  });
  await page.waitForTimeout(300);
  await expect.poll(() => distanceFromBottom(container)).toBeGreaterThan(4);
  // WebKit sometimes lands well past 20px here: with no scroll anchoring, the
  // rows mounted above the reader re-measure and move the pane further up. The
  // button is then rightly visible already, and the assertion that matters —
  // it is visible once the content grows — still holds below.
  if (await distanceFromBottom(container) < 50) {
    await expect(scrollButton).toBeHidden();
  }

  // Then the content grows below the reader while they hold still — what a
  // streaming reply does, one growing bubble. Nothing scrolls, so no `scroll`
  // event fires. Grown directly rather than through the mock, which cannot
  // stream: its reply lands as one message, and the row mount/measure that
  // follows fires scroll events of its own, which is exactly what hid this.
  //
  // Scroll events are counted from here until the button first appears. Before
  // the fix the button was only ever recomputed on a scroll event, so given long
  // enough some unrelated re-render scrolled and it turned up anyway — seconds
  // late for a reader watching a reply stream in. What must hold is that the
  // growth alone brings it, with no scroll event in between. (Counted rather
  // than timed: headless WebKit delivers the ResizeObserver callback ~1s late.)
  await container.evaluate((el) => {
    // Already showing means the read-up above overshot the band (WebKit), so
    // there is no hidden-button state for the growth to fix: nothing to count.
    const alreadyShowing = Boolean(document.querySelector('[aria-label="Scroll to bottom"]'));
    const probe = { scrolls: 0, scrollsBeforeButton: alreadyShowing ? 0 : -1 };
    (window as unknown as { __growthProbe: typeof probe }).__growthProbe = probe;
    el.addEventListener('scroll', () => { probe.scrolls += 1; });
    const observer = new MutationObserver(() => {
      if (probe.scrollsBeforeButton < 0 && document.querySelector('[aria-label="Scroll to bottom"]')) {
        probe.scrollsBeforeButton = probe.scrolls;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true });
    const growth = document.createElement('div');
    growth.style.height = '600px';
    el.firstElementChild?.appendChild(growth);
  });

  // The reader keeps their place (they took control) …
  await expect.poll(() => distanceFromBottom(container)).toBeGreaterThan(50);
  // … and the growth itself surfaces the button.
  await expect(scrollButton).toBeVisible();
  const scrollsBeforeButton = await page.evaluate(
    () => (window as unknown as { __growthProbe: { scrollsBeforeButton: number } }).__growthProbe.scrollsBeforeButton,
  );
  expect(scrollsBeforeButton, 'the button should appear from the growth, not a later scroll').toBe(0);
});
