import type { Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { seedLargeConversation, type LargeConversationHandles } from './largeConversationFixture';

/**
 * cloudcli#495 — "when scrolling up it's not a smooth scroll, scroll position
 * jumps around as content is dynamically loaded".
 *
 * What a reader perceives is not `scrollTop`. Paging older messages in *must*
 * move `scrollTop` (the content above them grew), and the virtualizer moves it
 * again as estimated row heights are replaced by measured ones. Both are
 * correct, which makes `scrollTop` useless as a stability signal. What the
 * reader actually sees is **the message they are looking at**, so that is what
 * this measures: take the row nearest the viewport's midpoint, drag up by a
 * known number of pixels, and check that row moved down by that many and no
 * more. A row that lurches further than the drag asked for, or travels
 * *upward* while the reader scrolls up, is the jump in the report.
 *
 * Runs on WebKit under an iPhone UA, and nowhere else — `playwright.config.ts`
 * explains why no Chromium project can detect this regression at all.
 *
 * The behaviour it caught: `.chat-message` carried `content-visibility: auto`
 * with a fixed `contain-intrinsic-size` placeholder, so every message collapsed
 * to that placeholder on leaving the viewport and expanded back on re-entering
 * it. Scrolling up therefore kept resizing the content *above* the reader, and
 * a 240px drag moved the message they were reading by as little as 24px.
 */

interface RowSample {
  index: number;
  top: number;
}

/**
 * Picks the row nearest the pane's vertical midpoint — what the reader is
 * looking at — and stashes *that DOM element* on `window` so the follow-up read
 * can re-measure the very same node.
 *
 * Holding the element rather than re-finding it by text is what makes the
 * measurement trustworthy. A fixture message's text appears in more than one
 * `.chat-message` in the grouped/tool rows, so a text search can silently
 * re-find a *different* element than the one it sampled and report the gap
 * between two unrelated nodes as scroll movement — a repeating cycle of
 * displacement values that tracks the fixture's 5-row tool pattern, not
 * anything the app did.
 *
 * "Nearest", not "the one spanning the midpoint": rows are absolutely
 * positioned with their inter-row gap baked in as padding on the wrapper, so
 * the midpoint regularly lands in a gap that no `.chat-message` covers, and a
 * strict spanning test discards precisely the frames where the gaps moved.
 */
async function readCentreRow(container: Locator): Promise<RowSample | null> {
  return container.evaluate((el) => {
    const pattern = /message #(\d+) of/;
    const paneRect = el.getBoundingClientRect();
    const midpoint = paneRect.top + paneRect.height / 2;
    let best: { element: Element; index: number; top: number; distance: number } | null = null;
    for (const row of Array.from(el.querySelectorAll('.chat-message'))) {
      const matched = pattern.exec(row.textContent || '');
      if (!matched) continue;
      const rect = row.getBoundingClientRect();
      const distance = rect.top <= midpoint && rect.bottom >= midpoint
        ? 0
        : Math.min(Math.abs(rect.top - midpoint), Math.abs(rect.bottom - midpoint));
      if (!best || distance < best.distance) {
        best = { element: row, index: Number(matched[1]), top: rect.top - paneRect.top, distance };
      }
    }
    (window as unknown as { __scrollAnchor?: Element | null }).__scrollAnchor = best?.element ?? null;
    return best ? { index: best.index, top: best.top } : null;
  });
}

/** Where the stashed anchor element sits now, or `null` if it was unmounted. */
async function readStashedAnchor(container: Locator): Promise<number | null> {
  return container.evaluate(() => {
    const anchor = (window as unknown as { __scrollAnchor?: Element | null }).__scrollAnchor;
    if (!anchor || !anchor.isConnected) return null;
    const pane = document.querySelector('.chat-messages-pane');
    if (!pane) return null;
    return anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  });
}

/**
 * Drives one upward drag.
 *
 * Playwright refuses `mouse.wheel` on mobile WebKit ("Mouse wheel is not
 * supported"), and a phone has no wheel to emulate anyway.
 *
 * So the drag is driven as a real scroll of the real container, bracketed by
 * the `touchstart`/`touchmove`/`touchend` pair that both consumers key off:
 * `@tanstack/virtual-core` registers plain `touchstart`/`touchend` listeners to
 * decide whether to defer a correction, and `ChatMessagesPane`'s `onTouchMove`
 * is what tells auto-follow a human is scrolling. Neither reads the event's
 * payload, so a bare bubbling `Event` drives both exactly as a finger does —
 * the scroll itself is genuine, only the input device is synthesised.
 */
async function touchScrollUp(container: Locator, deltaY: number) {
  await container.evaluate((el, delta) => {
    el.dispatchEvent(new Event('touchstart', { bubbles: true }));
    el.scrollTop -= delta;
    el.dispatchEvent(new Event('touchmove', { bubbles: true }));
    el.dispatchEvent(new Event('touchend', { bubbles: true }));
  }, deltaY);
}

interface Displacement {
  /** Fixture row index that was tracked across the step. */
  row: number;
  /** How far it moved on screen. Positive = downward = the direction scrolling up should move content. */
  moved: number;
  /**
   * How far the content was actually asked to move.
   *
   * Not simply the step size: a scroll that starts 30px from the top can only
   * deliver 30px of it before the browser clamps at 0, and counting the unspent
   * remainder as "requested" would read a perfectly ordinary clamp as the
   * content refusing to follow the scroll.
   */
  requested: number;
  /** Whether older messages were paged in during this step. */
  paged: boolean;
}

/**
 * One drag, measured against the row the reader is looking at.
 *
 * The anchor is re-read once the scroll has *settled*, not immediately: a row
 * entering the viewport does not reach its real height in the same frame, and
 * `@tanstack/virtual-core` defers its own scroll corrections on iOS until
 * scrolling stops. An immediate read would sample before either lands.
 */
async function measureStep(
  page: Page,
  container: Locator,
  step: number,
): Promise<Displacement | null> {
  const before = await readCentreRow(container);
  if (!before) return null;
  const stateBefore = await container.evaluate((el) => ({
    scrollTop: el.scrollTop,
    loaded: el.querySelectorAll('.chat-message').length,
  }));

  await touchScrollUp(container, step);
  // Long enough for a page of older messages to arrive, for the newly mounted
  // rows to be measured, and for the iOS deferred-adjustment flush to land.
  await page.waitForTimeout(600);

  const afterTop = await readStashedAnchor(container);
  if (afterTop === null) return null;
  const loadedAfter = await container.evaluate((el) => el.querySelectorAll('.chat-message').length);

  return {
    row: before.index,
    moved: afterTop - before.top,
    requested: Math.min(step, stateBefore.scrollTop),
    paged: loadedAfter > stateBefore.loaded,
  };
}

let fixture: LargeConversationHandles;

test.setTimeout(180_000);

test.beforeEach(async ({ server }) => {
  fixture = seedLargeConversation(server.home, server.projectPath);
});

test('scrolling up through paginated history keeps the reader\'s view steady', async ({ page }, testInfo) => {
  await page.goto(`/session/${fixture.sessionId}`);

  const container = page.locator('.chat-messages-pane');
  await expect(container).toBeVisible();
  await expect(page.getByText(fixture.lastMessageText)).toBeVisible({ timeout: 60_000 });

  // Opening a session re-pins the bottom every frame for up to a second while
  // lazily-rendered content settles (`useChatSessionState`'s initial-scroll
  // loop). It bows out to a real pointer gesture, which a synthesised touch
  // event is not, so scrolling inside that window would be measuring a fight
  // between the test and the landing rather than the behaviour under test.
  await page.waitForTimeout(1_500);

  // A step small enough that a whole page of history cannot scroll past inside
  // one of them, so every step has a surviving anchor to measure against.
  const STEP = 240;
  // Sub-pixel layout, a row's own internal reflow, and the browser's own
  // rounding all move an anchor a little. Anything past this is not rounding.
  const TOLERANCE = 32;
  // No single step may miss by more than this. Set below the smallest
  // systematic miss the unfixed code produced (149px) and far below its worst
  // (834px), so the regression cannot slip through on the ceiling either, while
  // leaving room for one row's late reflow under a loaded CI host.
  const WORST_STEP_TOLERANCE = 120;

  const displacements: Displacement[] = [];
  let unproductive = 0;
  for (let i = 0; i < 30 && displacements.length < 12; i++) {
    const step = await measureStep(page, container, STEP);
    if (step) displacements.push(step);

    // Reaching the top is not the end of the scroll — it is what *triggers* the
    // next page (`useChatSessionState`'s `loadOlderMessages`), and the page
    // landing is the moment the report is about. Wait for the prepend to push
    // the viewport back down and carry on.
    if (!(await container.evaluate((el) => el.scrollTop < 4))) {
      unproductive = 0;
      continue;
    }

    const grew = await container.evaluate(
      (el, previous) =>
        new Promise<boolean>((resolve) => {
          // Generous, because this is waiting on a real server round-trip on a
          // host that runs this suite next to a dozen other CI containers. A
          // page that takes 6s to land is slow, not absent, and giving up on it
          // ends the walk early — which used to leave the run short of the
          // sample count its own preconditions ask for, failing the test with
          // every measured step perfect.
          const deadline = Date.now() + 8_000;
          const poll = () => {
            if (el.scrollTop > 4 || el.querySelectorAll('.chat-message').length > previous) {
              resolve(true);
            } else if (Date.now() > deadline) {
              resolve(false);
            } else {
              setTimeout(poll, 100);
            }
          };
          poll();
        }),
      await container.evaluate((el) => el.querySelectorAll('.chat-message').length),
    );

    if (grew) {
      unproductive = 0;
      continue;
    }

    // Wedged at the top: either history really is exhausted, or the next page
    // is taking longer than the wait above under a loaded host. Either way the
    // walk must not end here — the sample count is a preconditon of the test,
    // and letting a slow page decide it is what made this spec fail with every
    // measured step perfect.
    //
    // Dropping back down a few screens and climbing again re-measures loaded
    // content, which is where the reported symptom lives anyway: the rows that
    // misbehaved in the original repro were overwhelmingly ones already paged
    // in, resized by nothing more than entering and leaving the viewport.
    unproductive += 1;
    if (unproductive >= 3) break;
    await container.evaluate((el, delta) => {
      el.scrollTop += delta;
    }, STEP * 4);
    await page.waitForTimeout(400);
  }

  console.log(
    `[#495] ${testInfo.project.name} anchor tracking:\n` +
      displacements
        .map(
          (d) =>
            `  row #${d.row}: asked ${d.requested.toFixed(0)}px, moved ${d.moved.toFixed(0)}px` +
            ` (off by ${(d.moved - d.requested).toFixed(0)}px)${d.paged ? ' [paged]' : ''}`,
        )
        .join('\n'),
  );

  // Preconditions, not the point of the test: they only certify that the run
  // actually reproduced the reported conditions — a real scroll, across at
  // least one round of "content dynamically loaded". Kept below what a healthy
  // run produces (~10 measured steps, 3-4 of them paged), because a step whose
  // anchor row scrolled out of the mounted window is skipped rather than
  // measured, and how many of those a run hits is timing.
  expect(displacements.length).toBeGreaterThanOrEqual(6);
  expect(displacements.filter((d) => d.paged).length).toBeGreaterThanOrEqual(1);

  // The invariant, in both directions. Overshooting means the content lurched
  // further than the reader asked for; undershooting means it resisted the
  // scroll and got dragged back. Both read as "the scroll position jumps
  // around".
  const deviations = displacements.map((d) => Math.abs(d.moved - d.requested)).sort((a, b) => a - b);
  const median = deviations[Math.floor(deviations.length / 2)];
  const worst = deviations[deviations.length - 1];

  // Asserted on the median rather than on every step, because the two failures
  // are different in kind. The bug is *systematic*: on the unfixed code four
  // steps in five missed by 149-216px and the median deviation was ~165px,
  // because every row entering or leaving the viewport resized the content
  // above the reader. What survives on the fixed code is the occasional single
  // step knocked out by a row finishing its own async layout late under CI
  // load — real, but one-off, and not what the reader reported. A median
  // demands that steps track the scroll *as a rule*, while the ceiling below
  // still catches any individual lurch big enough to notice.
  expect(
    median,
    `the reader's view did not track the scroll as a rule (per-step deviations: ${deviations.join(', ')}px)`,
  ).toBeLessThanOrEqual(TOLERANCE);
  expect(
    worst,
    `one step lurched far past what the scroll asked for (per-step deviations: ${deviations.join(', ')}px)`,
  ).toBeLessThanOrEqual(WORST_STEP_TOLERANCE);
});
