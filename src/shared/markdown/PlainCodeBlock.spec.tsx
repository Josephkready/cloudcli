import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import PlainCodeBlock from './PlainCodeBlock';
import { CODE_BLOCK_FONT_FAMILY, codeBlockPadding } from './codeBlockStyle';

/**
 * #287: Prism is demand-loaded, and this renders in its place while the chunk
 * downloads. The promise it makes is that the swap changes COLOUR and nothing
 * else — so the first assistant message must not reflow under the reader.
 *
 * Tested directly rather than through `Markdown`: `React.lazy` caches a resolved
 * module, so once any earlier test has loaded the highlighter the fallback is
 * never rendered again in that file. A test of it through the boundary passes
 * alone and fails in suite order, which is worse than no test.
 */

/**
 * The DOM collapses padding shorthand (`2rem 1rem 1rem 1rem` becomes
 * `2rem 1rem 1rem` once left and right match), so the expected value has to go
 * through the same normalisation or the comparison fails on formatting rather
 * than on a real difference.
 */
function normalizedPadding(value: string): string {
  const probe = document.createElement('div');
  probe.style.padding = value;
  return probe.style.padding;
}

describe('PlainCodeBlock — the stand-in shown while Prism loads', () => {
  it('shows the full source immediately, so no code is missing mid-load', () => {
    const code = 'const answer = 42;\nconst doubled = answer * 2;';
    const { getByTestId } = render(
      <PlainCodeBlock code={code} language="ts" isDarkMode={false} />,
    );

    expect(getByTestId('plain-code-block').textContent).toBe(code);
  });

  it('matches the highlighter’s padding, which is what stops the block jumping', () => {
    // Both components read this from codeBlockStyle; if the fallback ever
    // hard-codes its own value the block visibly shifts when Prism arrives.
    const { getByTestId, rerender } = render(
      <PlainCodeBlock code="x" language="ts" isDarkMode={false} />,
    );
    expect(getByTestId('plain-code-block').style.padding).toBe(normalizedPadding(codeBlockPadding('ts')));

    // A block with no language has no label to leave room for, so it gets the
    // plain inset — the same branch the highlighter takes.
    rerender(<PlainCodeBlock code="x" language="text" isDarkMode={false} />);
    expect(getByTestId('plain-code-block').style.padding).toBe(normalizedPadding(codeBlockPadding('text')));
  });

  it('uses the same monospace stack, so glyph widths do not change', () => {
    const { container } = render(<PlainCodeBlock code="x" language="ts" isDarkMode={false} />);

    const code = container.querySelector('code');
    expect(code?.style.fontFamily).toBe(CODE_BLOCK_FONT_FAMILY);
  });

  it('carries a dark background in dark mode rather than flashing light', () => {
    const { getByTestId, rerender } = render(
      <PlainCodeBlock code="x" language="ts" isDarkMode />,
    );
    const dark = getByTestId('plain-code-block').style.background;

    rerender(<PlainCodeBlock code="x" language="ts" isDarkMode={false} />);
    const light = getByTestId('plain-code-block').style.background;

    expect(dark).not.toBe(light);
    expect(dark).toBeTruthy();
  });

  it('marks itself busy, so assistive tech knows it is transitional', () => {
    const { getByTestId } = render(<PlainCodeBlock code="x" language="ts" isDarkMode={false} />);

    expect(getByTestId('plain-code-block').getAttribute('aria-busy')).toBe('true');
  });
});
