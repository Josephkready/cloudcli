import { test, expect } from './fixtures';

/**
 * Mermaid diagrams, in a real browser, against the real library.
 *
 * The unit and component suites cover the decisions — which fences are mermaid,
 * which have finished streaming, what happens when a render fails — but they all
 * stub the runtime out, because jsdom has no layout engine and mermaid cannot
 * measure text without one. So none of them can answer the only question that
 * really matters: does a ```` ```mermaid ```` fence actually turn into a picture?
 *
 * The reply comes back through the mock provider's `echo:` seam, because user
 * messages are rendered as plain text on purpose — an assistant bubble is the
 * only place the markdown renderer ever runs.
 */

const VALID_DIAGRAM = ['```mermaid', 'graph TD', '  Start --> Finish', '```'].join('\n');

// Nonsense to mermaid's parser, and exactly the shape agents emit when they get
// it wrong: a real diagram header followed by a broken edge.
const INVALID_DIAGRAM = ['```mermaid', 'graph TD', '  A -->|unclosed', '  ((((', '```'].join('\n');

async function sendEchoed(page: import('@playwright/test').Page, markdown: string) {
  await page.goto('/');
  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();
  await composer.fill(`echo:${markdown}`);
  await page.getByRole('button', { name: 'Send' }).click();
}

test('renders a mermaid fence as real SVG', async ({ page }) => {
  await sendEchoed(page, `Here is the flow:\n\n${VALID_DIAGRAM}\n\nThat is all.`);

  const assistant = page.locator('.chat-message.assistant');
  const diagram = assistant.locator('[data-testid="mermaid-diagram"]');

  // The mermaid chunk is fetched on demand, so the first diagram of a session
  // takes a beat; before it lands the source is showing, which is correct.
  await expect(diagram).toBeVisible({ timeout: 30_000 });

  // Proof it is a drawn diagram and not markup we echoed: mermaid emits an
  // <svg> containing the node labels as rendered text.
  const svg = diagram.locator('svg');
  await expect(svg).toBeVisible();
  await expect(svg).toContainText('Start');
  await expect(svg).toContainText('Finish');
  expect(await svg.locator('g').count()).toBeGreaterThan(0);

  // The prose either side of the diagram is untouched.
  await expect(assistant.getByText('Here is the flow:')).toBeVisible();
  await expect(assistant.getByText('That is all.')).toBeVisible();
});

test('shows the source and keeps the message when a diagram is invalid', async ({ page }) => {
  await sendEchoed(page, `Broken:\n\n${INVALID_DIAGRAM}\n\nStill here.`);

  const assistant = page.locator('.chat-message.assistant');

  // The rest of the message must survive a diagram that cannot be drawn — this
  // is the behaviour the whole fallback path exists for.
  await expect(assistant.getByText('Broken:')).toBeVisible();
  await expect(assistant.getByText('Still here.')).toBeVisible();

  // The source falls through to an ordinary code block…
  await expect(assistant.locator('pre')).toContainText('graph TD');
  // …and no diagram is claimed. Asserted after the surrounding text is on
  // screen, so this is "never rendered", not "not rendered yet".
  await expect(assistant.locator('[data-testid="mermaid-diagram"]')).toHaveCount(0);

  // No error boundary, no blanked transcript: the composer is usable again.
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
});

// Deliberately far wider than the chat column: four actors and long labels.
const WIDE_DIAGRAM = [
  '```mermaid',
  'sequenceDiagram',
  '  participant Browser as Browser (PWA shell)',
  '  participant Express as Express gateway',
  '  participant Gateway as Chat WebSocket gateway',
  '  participant Provider as Provider runtime (claude/codex)',
  '  Browser->>Express: POST /api/agent with the prompt',
  '  Express->>Gateway: hand the run to the session writer',
  '  Gateway->>Provider: spawn and stream normalized frames',
  '  Provider-->>Gateway: forward each frame over the socket',
  '```',
].join('\n');

test('scrolls a wide diagram inside its own box, not the page', async ({ page }) => {
  // Two failure modes, opposite directions, and this asserts against both.
  //
  // Squeeze: `index.css` has `.chat-message * { max-width: 100% }`, which is why
  // a message never widens the page — and which shrank a 1300px diagram to
  // 303px on a phone. The container opts its SVG out of that rule.
  //
  // Spill: having opted out, the natural width must be absorbed by the box's own
  // scroller rather than reaching the document.
  await sendEchoed(page, `Wide one:\n\n${WIDE_DIAGRAM}`);

  const diagram = page.locator('[data-testid="mermaid-diagram"]');
  await expect(diagram.locator('svg')).toBeVisible({ timeout: 30_000 });

  const metrics = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="mermaid-diagram"]') as HTMLElement;
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
      boxClientWidth: box.clientWidth,
      boxScrollWidth: box.scrollWidth,
      svgWidth: box.querySelector('svg')!.getBoundingClientRect().width,
    };
  });

  // The diagram keeps its natural width…
  expect(metrics.svgWidth).toBeGreaterThan(metrics.boxClientWidth);
  // …the box scrolls to reach it…
  expect(metrics.boxScrollWidth).toBeGreaterThan(metrics.boxClientWidth);
  // …and the transcript itself does not scroll sideways.
  expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageClientWidth);
});

test('draws a valid diagram alongside an invalid one in the same message', async ({ page }) => {
  await sendEchoed(page, `${VALID_DIAGRAM}\n\nand a broken one:\n\n${INVALID_DIAGRAM}`);

  const assistant = page.locator('.chat-message.assistant');

  await expect(assistant.locator('[data-testid="mermaid-diagram"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(assistant.locator('[data-testid="mermaid-diagram"] svg')).toContainText('Finish');
  await expect(assistant.getByText('and a broken one:')).toBeVisible();
  await expect(assistant.locator('pre')).toContainText('unclosed');
});
