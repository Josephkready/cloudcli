import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({ currentVersion: '1.2.3' }),
}));

const { default: AboutTab } = await import('./AboutTab');

describe('AboutTab', () => {
  it('renders the current version and external links', () => {
    render(<AboutTab />);
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /star on github/i })).toHaveAttribute(
      'href',
      'https://github.com/siteboon/claudecodeui',
    );
    expect(screen.getByRole('link', { name: /discord/i })).toHaveAttribute(
      'href',
      'https://discord.gg/buxwujPNRE',
    );
    expect(screen.getByRole('link', { name: /docs/i })).toHaveAttribute(
      'href',
      'https://cloudcli.ai/docs/plugin-overview',
    );
    expect(screen.getByRole('link', { name: /cloudcli\.ai/i })).toHaveAttribute(
      'href',
      'https://cloudcli.ai',
    );
    expect(screen.getByText('Licensed under AGPL-3.0')).toBeInTheDocument();
  });

  it('shows the OSS-mode hosted CTA and pro feature cards when not platform mode', () => {
    render(<AboutTab />);
    expect(screen.getByText('Try CloudCLI Hosted')).toBeInTheDocument();
    expect(screen.getByText('CloudCLI Pro Features')).toBeInTheDocument();
    expect(screen.getByText('Sync Settings')).toBeInTheDocument();
    expect(screen.getByText('Team Management')).toBeInTheDocument();
  });
});
