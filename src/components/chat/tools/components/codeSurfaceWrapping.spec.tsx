import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';

import { BashCommandDisplay } from './BashCommandDisplay';
import { CollapsibleDisplay } from './CollapsibleDisplay';
import { OneLineDisplay } from './OneLineDisplay';
import { TextContent } from './ContentRenderers/TextContent';
import { ErrorResultContent } from '../../view/subcomponents/ErrorResultContent';

/**
 * One rule, applied to every block-level code surface in chat: keep the line
 * structure and scroll sideways. Never wrap.
 *
 * Written as a *contract* rather than a per-component snapshot of a class
 * string. Asserting `className === '...'` would restate the implementation —
 * it would break on a harmless restyle while still passing if someone
 * reintroduced wrapping through a different class. The rule is what matters:
 *
 *   1. no wrapping class present — `whitespace-pre-wrap`, `break-all` and
 *      `break-words` are three separate ways to reintroduce the same defect,
 *   2. `whitespace-pre` present, so a long line stays one line, and
 *   3. a horizontal scroll affordance, or that preserved long line is merely
 *      clipped and unreachable, which is worse than wrapping.
 *
 * Rule 3 is the one most worth having: `whitespace-pre` with no `overflow-*`
 * looks right in a narrow test and silently swallows content in the app.
 *
 * Scope note. These surfaces carry LOCAL Tailwind classes, which is why they
 * are checkable here at all. The fenced code block is NOT — it hung on the
 * global `!important` rule in `src/index.css` beating the syntax highlighter's
 * own `overflow: auto`, and only a real layout engine can settle that. It is
 * measured for real in `e2e/code-block-scroll.spec.ts` via
 * `scrollWidth > clientWidth`, because jsdom has no layout at all.
 */

const WRAPPING_CLASSES = ['whitespace-pre-wrap', 'break-all', 'break-words'];

const expectScrollsNotWraps = (element: Element | null, label: string) => {
  expect(element, `${label}: expected to find the code surface`).not.toBeNull();
  const classes = [...(element as Element).classList];

  for (const wrapping of WRAPPING_CLASSES) {
    expect(
      classes,
      `${label}: "${wrapping}" reintroduces wrapping on a block code surface`,
    ).not.toContain(wrapping);
  }
  expect(classes, `${label}: must preserve line structure`).toContain('whitespace-pre');
  expect(
    classes.some((c) => c === 'overflow-auto' || c === 'overflow-x-auto'),
    `${label}: whitespace-pre with no overflow affordance clips the long line instead of scrolling it`,
  ).toBe(true);
};

const LONG = 'const x = someCall(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive);';

describe('block code surfaces scroll rather than wrap', () => {
  it('Bash output', () => {
    // Rendered into the DOM rather than to static markup: the expanded state is
    // applied by an effect, which server rendering never runs — SSR would find
    // no output block and the assertion would pass vacuously.
    const { container } = render(
      <BashCommandDisplay command="rg pattern src/" output={LONG} defaultOpen status="completed" />,
    );
    expectScrollsNotWraps(container.querySelector('pre'), 'BashCommandDisplay output');
  });

  it('raw params (CollapsibleDisplay)', () => {
    const { container } = render(
      <CollapsibleDisplay toolName="Edit" title="file.ts" showRawParameters rawContent={LONG}>
        <div />
      </CollapsibleDisplay>,
    );
    expectScrollsNotWraps(container.querySelector('pre'), 'CollapsibleDisplay raw params');
  });

  it('code text (TextContent)', () => {
    const { container } = render(<TextContent content={LONG} format="code" />);
    expectScrollsNotWraps(container.querySelector('pre'), 'TextContent format=code');
  });

  it('error / stderr output', () => {
    const { container } = render(<ErrorResultContent content={LONG} />);
    expectScrollsNotWraps(container.querySelector('pre'), 'ErrorResultContent');
  });

  it('one-line terminal display when it is asked to wrap text', () => {
    const { container } = render(
      <OneLineDisplay toolName="Bash" style="terminal" value={LONG} wrapText />,
    );
    // A <code>, not a <pre>. `block` matters as much as the overflow class:
    // `overflow-x` has no effect on an inline box, so an inline <code> would
    // silently refuse to scroll.
    const surface = container.querySelector('code');
    expectScrollsNotWraps(surface, 'OneLineDisplay terminal');
    expect([...(surface as Element).classList], 'an inline box cannot scroll').toContain('block');
  });
});

describe('summary rows are not code surfaces', () => {
  it('a collapsed Bash command truncates to one line instead of wrapping', () => {
    // The header carries the call's identity and must stay a single line. Its
    // `truncate` only survives because the global inline-code rule in
    // index.css is wrapped in `:where()`, so it loses to a component class —
    // unwrapped, that rule scores (0,1,2), beats `truncate` (0,1,0), and the
    // row wraps. The rendered consequence is measured in
    // e2e/code-block-scroll.spec.ts.
    const { container } = render(
      <BashCommandDisplay command={LONG} output="done" status="completed" />,
    );
    const header = container.querySelector('code');
    expect(header, 'expected the command header').not.toBeNull();
    expect([...(header as Element).classList]).toContain('truncate');
  });
});
