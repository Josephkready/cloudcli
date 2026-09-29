import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { MarkdownContent } from './MarkdownContent';

afterEach(() => {
  cleanup();
});

describe('MarkdownContent', () => {
  it('renders markdown content (heading + paragraph)', async () => {
    render(<MarkdownContent content={'# Title\n\nBody text here'} />);
    // `Markdown` is demand-loaded (perf-audit package WP7): the raw text shows
    // through a plain-text fallback first, then the heading/paragraph markup
    // lands once the renderer chunk resolves.
    await waitFor(() => {
      expect(screen.getByText('Title')).toBeTruthy();
    });
    expect(screen.getByText('Body text here')).toBeTruthy();
  });

  it('applies the default className when none is provided', () => {
    const { container } = render(<MarkdownContent content="hello" />);
    expect(container.querySelector('.prose')).toBeTruthy();
  });

  it('applies a custom className when provided', () => {
    const { container } = render(<MarkdownContent content="hello" className="my-custom-class" />);
    expect(container.querySelector('.my-custom-class')).toBeTruthy();
  });
});
