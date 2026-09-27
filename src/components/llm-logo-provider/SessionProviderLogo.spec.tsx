import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SessionProviderLogo from './SessionProviderLogo';

/*
 * The only real logic in this component is the provider -> icon dispatch; the three
 * SVG components it delegates to are pure markup with no branches of their own.
 */
describe('SessionProviderLogo', () => {
  it('renders the Codex logo for provider "codex"', () => {
    const { container } = render(<SessionProviderLogo provider="codex" />);
    expect(container.querySelector('svg[aria-label="Codex"]')).toBeInTheDocument();
  });

  it('renders the Antigravity logo for provider "antigravity"', () => {
    const { container } = render(<SessionProviderLogo provider="antigravity" />);
    expect(container.querySelector('svg[aria-label="Antigravity"]')).toBeInTheDocument();
  });

  it('falls back to the Claude logo for any other provider', () => {
    const { container } = render(<SessionProviderLogo provider="claude" />);
    expect(container.querySelector('svg[aria-label="Claude"]')).toBeInTheDocument();
  });

  it('falls back to the Claude logo when no provider is given', () => {
    const { container } = render(<SessionProviderLogo />);
    expect(container.querySelector('svg[aria-label="Claude"]')).toBeInTheDocument();
  });

  it('falls back to the Claude logo for an unrecognised provider string', () => {
    const { container } = render(<SessionProviderLogo provider="some-unknown-provider" />);
    expect(container.querySelector('svg[aria-label="Claude"]')).toBeInTheDocument();
  });

  it('passes the className through to the rendered icon', () => {
    const { container } = render(<SessionProviderLogo provider="codex" className="custom-class" />);
    expect(container.querySelector('svg.custom-class')).toBeInTheDocument();
  });
});
