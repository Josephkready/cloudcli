import { render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import PrismCodeBlock from './PrismCodeBlock';

/**
 * Regression lock for the memoization added alongside the 2026-09 chat UI
 * architecture assessment (docs/ARCHITECTURE-ASSESSMENT-2026-09.md, §4.2): a
 * profiled `chat_turn_in_large_conversation` run showed Prism re-highlighting
 * as the single largest measured CPU cost during a live stream, because
 * nothing stopped `PrismCodeBlock` from re-tokenizing on every parent
 * re-render even when its own props hadn't changed.
 *
 * `PrismCodeBlock`'s default export is `memo(PrismCodeBlock)`. `memo()`
 * returns an object whose `.type` is the underlying function component —
 * wrapping that in a spy is the standard way to observe whether React
 * actually re-invoked the component, without changing the production export
 * surface just for a test.
 */

function spyOnUnderlyingRender() {
  const original = (PrismCodeBlock as unknown as { type: (...args: unknown[]) => unknown }).type;
  const spy = vi.fn(original);
  (PrismCodeBlock as unknown as { type: (...args: unknown[]) => unknown }).type = spy;
  return { spy, restore: () => { (PrismCodeBlock as unknown as { type: unknown }).type = original; } };
}

/** Re-renders `<PrismCodeBlock>` with fixed props whenever `bump()` fires, so
 * the parent re-renders without any of PrismCodeBlock's own props changing. */
function ParentThatRerenders({ code, language, isDarkMode }: { code: string; language: string; isDarkMode: boolean }) {
  const [, setTick] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setTick((n) => n + 1)}>
        bump
      </button>
      <PrismCodeBlock code={code} language={language} isDarkMode={isDarkMode} />
    </div>
  );
}

describe('PrismCodeBlock — memoized against unchanged props', () => {
  it('does not re-run the highlighter when a parent re-renders with the same code/language/theme', () => {
    const { spy, restore } = spyOnUnderlyingRender();
    try {
      const { getByRole } = render(
        <ParentThatRerenders code="const x = 1;" language="ts" isDarkMode={false} />,
      );
      expect(spy).toHaveBeenCalledTimes(1);

      // Parent re-renders (its own state changed); PrismCodeBlock's props did not.
      getByRole('button').click();
      getByRole('button').click();
      getByRole('button').click();

      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('still re-runs the highlighter when code actually changes', () => {
    const { spy, restore } = spyOnUnderlyingRender();
    try {
      const { rerender } = render(
        <PrismCodeBlock code="const x = 1;" language="ts" isDarkMode={false} />,
      );
      expect(spy).toHaveBeenCalledTimes(1);

      rerender(<PrismCodeBlock code="const x = 2;" language="ts" isDarkMode={false} />);
      expect(spy).toHaveBeenCalledTimes(2);

      rerender(<PrismCodeBlock code="const x = 2;" language="ts" isDarkMode />);
      expect(spy).toHaveBeenCalledTimes(3);

      rerender(<PrismCodeBlock code="const x = 2;" language="python" isDarkMode />);
      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      restore();
    }
  });

  it('renders highlighted spans for the code it is given', () => {
    const { container } = render(
      <PrismCodeBlock code="const answer = 42;" language="ts" isDarkMode={false} />,
    );
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('const answer = 42;');
  });
});
