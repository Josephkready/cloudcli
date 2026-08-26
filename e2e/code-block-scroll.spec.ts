import { test, expect } from './fixtures';

import {
  MOCK_CODE_BLOCK_SENTINEL,
  MOCK_LONG_CODE_LINE,
  MOCK_LONG_INLINE_TOKEN,
} from '../server/routes/mock-agent-fixtures.js';

/**
 * A fenced code block in chat must keep its line structure and scroll sideways.
 *
 * This is the one assertion that actually proves the fix, and it can only be
 * made in a real engine: the regression was a CSS cascade
 * (`white-space: pre-wrap !important` on `.chat-message pre`, plus
 * `.chat-message * { max-width: 100% }` clamping the `<code>` inside the
 * scroller), and jsdom has no layout, so `scrollWidth` there is always 0. A
 * class-name assertion would restate the fix rather than test it — it would
 * still pass with the `!important` rule reinstated, which is precisely the bug.
 *
 * `scrollWidth > clientWidth` is the property that a wrapped block cannot have:
 * wrapping folds the long line into the available width, making the two equal.
 */

const codeBlockMetrics = async (page: import('@playwright/test').Page) => {
  const pre = page.locator('.chat-message.assistant pre').first();
  await expect(pre).toBeVisible();
  return pre.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    whiteSpace: getComputedStyle(el).whiteSpace,
  }));
};

const sendCodeSurfaceTurn = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();
  await composer.fill(`render code surfaces ${MOCK_CODE_BLOCK_SENTINEL}`);
  await page.getByRole('button', { name: 'Send' }).click();
  // The block is behind a lazy Prism boundary; the fallback renders the same
  // <pre> with the same metrics, so either one satisfies this wait.
  await expect(
    page.locator('.chat-message.assistant pre').first(),
  ).toContainText('computeSomething', { timeout: 20_000 });
  // Wait for the run to reach its terminal state before measuring. The tool
  // frames arrive AFTER the code block, and each one re-renders the transcript
  // — measuring mid-stream reads a layout that is about to change.
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
};

test.describe('fenced code blocks scroll instead of wrapping', () => {
  test('a long line makes the block horizontally scrollable at desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await sendCodeSurfaceTurn(page);

    const { scrollWidth, clientWidth, whiteSpace } = await codeBlockMetrics(page);

    expect(whiteSpace, 'the block must not be force-wrapped').not.toBe('pre-wrap');
    expect(
      scrollWidth,
      `code block should overflow its box (scrollWidth ${scrollWidth} vs clientWidth ${clientWidth})`,
    ).toBeGreaterThan(clientWidth);
  });

  test('the same block is scrollable, not wrapped, at mobile width', async ({ page }) => {
    // The narrow viewport is where force-wrapping did the most damage, and where
    // the `max-width: 100%` clamp on the inner <code> would silently re-wrap it.
    await page.setViewportSize({ width: 390, height: 780 });
    await sendCodeSurfaceTurn(page);

    const { scrollWidth, clientWidth } = await codeBlockMetrics(page);
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    // Scrolling is real, not just theoretically available.
    const pre = page.locator('.chat-message.assistant pre').first();
    await expect
      .poll(async () => {
        await pre.evaluate((el) => {
          el.scrollLeft = 120;
        });
        return pre.evaluate((el) => el.scrollLeft);
      })
      .toBeGreaterThan(0);
  });

  test('the long line survives intact rather than being folded', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await sendCodeSurfaceTurn(page);

    // The text content is unchanged by wrapping either way; what this pins is
    // that the block renders as ONE visual line. A wrapped block is several
    // line-boxes tall, so its height betrays it regardless of white-space.
    const pre = page.locator('.chat-message.assistant pre').first();
    const { height, lineHeight } = await pre.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2,
      };
    });
    // Two source lines plus padding. Wrapping the long line at 390px would take
    // roughly ten line-boxes, so this bound is comfortably clear of both cases.
    expect(height).toBeLessThan(lineHeight * 5);
    await expect(pre).toContainText(MOCK_LONG_CODE_LINE);
  });

  test('inline code inside prose still wraps into the column', async ({ page }) => {
    // The other half of the fix: scoping the wrap rule to `:not(pre) > code`
    // must not stop a long path in a sentence from folding, which is the
    // legitimate need the original rule was written for.
    await page.setViewportSize({ width: 390, height: 780 });
    await sendCodeSurfaceTurn(page);

    const inline = page
      .locator('.chat-message.assistant code', { hasText: MOCK_LONG_INLINE_TOKEN })
      .first();
    await expect(inline).toBeVisible();

    const { scrollWidth, clientWidth, viewportWidth } = await inline.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));

    // It wrapped: it does not overflow itself, and it stayed inside the viewport
    // rather than pushing the chat column sideways.
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    expect(clientWidth).toBeLessThanOrEqual(viewportWidth);
  });

  test('wide Bash output scrolls once the call is expanded', async ({ page }) => {
    // The other block surface the force-wrap rule hit. Its output is collapsed
    // behind the command header, so it has to be opened before it can be
    // measured at all.
    await page.setViewportSize({ width: 390, height: 900 });
    await sendCodeSurfaceTurn(page);

    await page.getByRole('button', { name: /rg --no-heading/ }).click();

    const output = page.locator('.chat-message pre', { hasText: 'TextContent.tsx:37' }).first();
    await expect(output).toBeVisible();

    const { scrollWidth, clientWidth, whiteSpace } = await output.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      whiteSpace: getComputedStyle(el).whiteSpace,
    }));
    expect(whiteSpace).toBe('pre');
    expect(scrollWidth).toBeGreaterThan(clientWidth);
  });

  test('a tool diff scrolls as one surface, keeping the gutter aligned', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await sendCodeSurfaceTurn(page);

    const scroller = page.locator('.chat-message [data-scrolls-x]').first();
    await expect(scroller).toBeVisible();

    const { scrollWidth, clientWidth } = await scroller.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    // Scrolling the container moves the +/- gutter with the code, which is the
    // point of scrolling the block as a whole rather than each line.
    await expect
      .poll(async () => {
        await scroller.evaluate((el) => {
          el.scrollLeft = 200;
        });
        return scroller.evaluate((el) => el.scrollLeft);
      })
      .toBeGreaterThan(0);

    // Every row is wide enough to have somewhere to scroll to.
    const rowWidths = await scroller.evaluate((el) =>
      [...el.children].map((row) => row.getBoundingClientRect().width),
    );
    expect(rowWidths.length).toBeGreaterThan(0);
    for (const width of rowWidths) {
      expect(width).toBeGreaterThan(clientWidth);
    }
  });

  test('the chat pane itself never scrolls sideways', async ({ page }) => {
    // Containment is the reason the wrap rule existed. A block that scrolls
    // internally must not make the page scroll — that would trade one defect
    // for a worse one.
    await page.setViewportSize({ width: 390, height: 780 });
    await sendCodeSurfaceTurn(page);

    const bodyOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(bodyOverflow.scrollWidth).toBeLessThanOrEqual(bodyOverflow.clientWidth + 1);
  });
});
