import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import TokenUsageSummary from './TokenUsageSummary';

/*
 * Regression coverage for "200,000 tokens, then 50,000" (Joseph's complaint):
 * the chip must read the context-window occupancy (input + cache tokens),
 * never fold in output tokens, and must never silently show 0/NaN for a
 * usage shape it doesn't recognise.
 */

describe('TokenUsageSummary', () => {
  it('shows the live frame\'s inputTokens (already inclusive of cache) rather than input + output', () => {
    render(
      <TokenUsageSummary
        usage={{ inputTokens: 87_000, outputTokens: 4_000, cacheReadTokens: 80_000, cacheCreationTokens: 0, total: 200_000 }}
      />,
    );

    // 87K, not 91K (which input + output would produce).
    expect(screen.getByRole('button', { name: /show token usage/i })).toHaveTextContent('87K');
    expect(screen.getByRole('button', { name: /show token usage/i })).not.toHaveTextContent('91K');
  });

  it('labels the chip as context, not a bare token count', () => {
    render(<TokenUsageSummary usage={{ inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }} />);

    expect(screen.getByText('context')).toBeInTheDocument();
  });

  it('renders the REST shape\'s `used` directly and shows the total denominator', () => {
    render(<TokenUsageSummary usage={{ used: 87_000, total: 200_000, breakdown: { input: 7_000, cacheCreation: 0, cacheRead: 80_000 } }} />);

    const button = screen.getByRole('button', { name: /show token usage/i });
    expect(button).toHaveTextContent('87K');
    expect(button).toHaveTextContent('/200K');
    expect(button.title).toContain('87,000 / 200,000');
  });

  it('shows cumulative output as a secondary figure only when the source reports one', () => {
    const { rerender } = render(
      <TokenUsageSummary usage={{ inputTokens: 1_000, outputTokens: 250, cacheReadTokens: 0, cacheCreationTokens: 0 }} />,
    );
    expect(screen.getByText('+250 out')).toBeInTheDocument();

    // REST shape carries no output figure at all — must not show a bogus "+0 out".
    rerender(<TokenUsageSummary usage={{ used: 1_000, total: 200_000, breakdown: { input: 1_000, cacheCreation: 0, cacheRead: 0 } }} />);
    expect(screen.queryByText(/out$/)).not.toBeInTheDocument();
  });

  it('renders 0 rather than crashing on a null/empty usage', () => {
    render(<TokenUsageSummary usage={null} />);
    expect(screen.getByRole('button', { name: /show token usage/i })).toHaveTextContent('0');
  });

  it('omits the denominator when total is zero or negative rather than showing "/0"', () => {
    const { rerender } = render(
      <TokenUsageSummary usage={{ inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, total: 0 }} />,
    );
    let button = screen.getByRole('button', { name: /show token usage/i });
    expect(button).not.toHaveTextContent('/0');
    expect(button.title).not.toContain('/');

    rerender(
      <TokenUsageSummary usage={{ inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, total: -5 }} />,
    );
    button = screen.getByRole('button', { name: /show token usage/i });
    expect(button).not.toHaveTextContent('/-5');
    expect(button.title).not.toContain('/');
  });
});
