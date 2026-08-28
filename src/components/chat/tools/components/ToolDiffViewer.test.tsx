import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolDiffViewer } from './ToolDiffViewer';

/**
 * The diff viewer scrolls sideways, and it does so via a coupling that spans
 * two files — which is exactly why it is worth a test.
 *
 * `src/index.css` clamps `.chat-message *` to `max-width: 100%` so a message
 * can never widen the chat column. Anything living INSIDE a horizontal scroller
 * has to be exempt from that clamp, or it is re-wrapped by the back door and
 * the scroller has nothing to scroll. The CSS grants that exemption to `pre`
 * descendants and to `[data-scrolls-x]` descendants; the diff viewer builds its
 * rows out of divs rather than a `<pre>`, so it depends on the second one.
 *
 * Nothing local fails if `data-scrolls-x` is dropped from the component or the
 * selector is dropped from the stylesheet — the diff just quietly starts
 * wrapping again. These tests pin both ends of that invisible contract.
 *
 * Layout itself is not asserted here: jsdom/node have no layout engine, so
 * `scrollWidth` is always 0. The measured proof lives in
 * `e2e/code-block-scroll.spec.ts`, which runs in a real browser.
 */

const createDiff = (oldStr: string, newStr: string) => [
  { type: 'removed', content: oldStr, lineNum: 1 },
  { type: 'added', content: newStr, lineNum: 1 },
];

const LONG_LINE = 'const x = someCall(argumentOne, argumentTwo, argumentThree, argumentFour);';

const render = () =>
  renderToStaticMarkup(
    React.createElement(ToolDiffViewer, {
      oldContent: LONG_LINE,
      newContent: `${LONG_LINE} // changed`,
      filePath: 'src/example.ts',
      createDiff,
    }),
  );

test('the diff rows sit inside a horizontal scroll container', () => {
  const html = render();
  // The scroller must both scroll and be marked for the CSS escape hatch.
  assert.match(html, /data-scrolls-x/, 'the scrolling wrapper must carry data-scrolls-x');
  const scroller = html.match(/<div data-scrolls-x[^>]*class="([^"]*)"/);
  assert.ok(scroller, 'expected a data-scrolls-x div with a class list');
  assert.match(scroller[1], /\boverflow-x-auto\b/, 'the marked element must be the scroller');
});

test('index.css exempts data-scrolls-x descendants from the max-width clamp', () => {
  // The other end of the contract. Without this selector the rows are clamped to
  // the scroller's width and the diff silently wraps again.
  // Resolved from this file, not `process.cwd()` — the latter passes under
  // `npm run test:unit` (which runs from the repo root) but throws ENOENT for an
  // IDE runner or a single-file run started from a subdirectory.
  const css = readFileSync(
    fileURLToPath(new URL('../../../../index.css', import.meta.url)),
    'utf8',
  );
  assert.match(
    css,
    /\.chat-message \[data-scrolls-x\] \*/,
    'src/index.css must exempt [data-scrolls-x] descendants from .chat-message * { max-width: 100% }',
  );
  assert.doesNotMatch(
    css,
    /white-space:\s*pre-wrap\s*!important/,
    'the force-wrap !important rule must not come back — it overrides every code surface',
  );
});

test('a diff row can grow wider than the scroller', () => {
  // `w-max` is what lets a long line extend past the viewport (giving the
  // scroller something to scroll); `min-w-full` keeps the +/- row background
  // spanning the full width when the line is short. Both are required.
  const html = render();
  // Only the markup inside the scroller — the header above it is also a flex
  // row, and it is deliberately not one of the things that scrolls.
  const insideScroller = html.split('data-scrolls-x')[1] ?? '';
  const rows = [...insideScroller.matchAll(/<div class="(flex[^"]*)"/g)].map((m) => m[1]);
  assert.ok(rows.length >= 2, `expected diff rows, got ${rows.length}`);
  for (const row of rows) {
    assert.match(row, /\bw-max\b/, `row must be able to exceed the scroller: ${row}`);
    assert.match(row, /\bmin-w-full\b/, `row must still fill a short line: ${row}`);
  }
});

test('diff line content keeps its line structure', () => {
  // The defect being fixed: `whitespace-pre-wrap` folded a wide diff line into
  // the column, so the +/- gutter no longer lined up with the code.
  const html = render();
  assert.match(html, /whitespace-pre\b/, 'diff content must use whitespace-pre');
  assert.doesNotMatch(
    html,
    /whitespace-pre-wrap/,
    'diff content must not wrap — that is what breaks gutter alignment',
  );
});
