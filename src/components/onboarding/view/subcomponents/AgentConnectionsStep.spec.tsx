import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createInitialProviderAuthStatusMap } from '../../../provider-auth/types';
import AgentConnectionsStep from './AgentConnectionsStep';

describe('AgentConnectionsStep', () => {
  it('renders a card per provider showing a loading state initially', () => {
    render(
      <AgentConnectionsStep
        providerStatuses={createInitialProviderAuthStatusMap(true)}
        onOpenProviderLogin={vi.fn()}
      />,
    );

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('OpenAI Codex')).toBeInTheDocument();
    expect(screen.getByText('Google Antigravity')).toBeInTheDocument();
    expect(screen.getAllByText('Checking...')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Login' })).not.toBeInTheDocument();
  });

  it('shows a connected email and a checkmark when authenticated', () => {
    const statuses = createInitialProviderAuthStatusMap(false);
    statuses.claude = { authenticated: true, email: 'jo@example.com', method: 'oauth', error: null, loading: false };

    render(<AgentConnectionsStep providerStatuses={statuses} onOpenProviderLogin={vi.fn()} />);

    expect(screen.getByText('jo@example.com')).toBeInTheDocument();
  });

  it('falls back to "Connected" when authenticated with no email', () => {
    const statuses = createInitialProviderAuthStatusMap(false);
    statuses.claude = { authenticated: true, email: null, method: 'oauth', error: null, loading: false };

    render(<AgentConnectionsStep providerStatuses={statuses} onOpenProviderLogin={vi.fn()} />);

    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('shows the error message and a Login button when not connected, and opens login on click', async () => {
    const user = userEvent.setup();
    const statuses = createInitialProviderAuthStatusMap(false);
    statuses.codex = { authenticated: false, email: null, method: null, error: 'Token expired', loading: false };
    const onOpenProviderLogin = vi.fn();

    render(<AgentConnectionsStep providerStatuses={statuses} onOpenProviderLogin={onOpenProviderLogin} />);

    expect(screen.getByText('Token expired')).toBeInTheDocument();
    const loginButtons = screen.getAllByRole('button', { name: 'Login' });
    expect(loginButtons).toHaveLength(3);

    await user.click(loginButtons[0]);
    expect(onOpenProviderLogin).toHaveBeenCalledWith('claude');
  });

  it('shows "Not connected" when there is no error and not authenticated', () => {
    const statuses = createInitialProviderAuthStatusMap(false);
    render(<AgentConnectionsStep providerStatuses={statuses} onOpenProviderLogin={vi.fn()} />);
    expect(screen.getAllByText('Not connected')).toHaveLength(3);
  });
});
