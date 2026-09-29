import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown';

/**
 * `Markdown.tsx` is the demand-loaded shell around `MarkdownRenderer.tsx`
 * (perf-audit package WP7) — the real rendering behaviour (Prism, KaTeX,
 * mermaid, file links, …) is covered end-to-end by `MarkdownRenderer.spec.tsx`.
 * These tests pin the two things specific to the wrapper: it shows the raw
 * text as a plain-text fallback before the chunk resolves, and the real
 * renderer's markdown output replaces it once the chunk lands, in the same
 * container.
 */
describe('Markdown (lazy wrapper)', () => {
  it('shows the raw text as a plain fallback, then swaps in rendered markdown', async () => {
    const { container } = render(
      <Markdown className="markdown-root">{'plain paragraph, **not yet bold**'}</Markdown>,
    );

    // Before the chunk resolves, the fallback shows the literal source text —
    // no markdown syntax has been interpreted yet, but nothing is blank either.
    expect(container.textContent).toContain('plain paragraph, **not yet bold**');
    expect(container.querySelector('strong')).toBeNull();

    // Once `MarkdownRenderer` loads, the same content re-renders as real
    // markdown in the same box.
    await waitFor(() => {
      expect(container.querySelector('strong')).not.toBeNull();
    });
    expect(container.querySelector('strong')?.textContent).toBe('not yet bold');
  });

  it('passes the className through on both the fallback and the loaded renderer', async () => {
    const { container } = render(<Markdown className="markdown-root">{'hello'}</Markdown>);

    expect(container.querySelector('.markdown-root')).not.toBeNull();

    await waitFor(() => {
      expect(screen.queryByText('hello')).not.toBeNull();
    });
    expect(container.querySelector('.markdown-root')).not.toBeNull();
  });
});
