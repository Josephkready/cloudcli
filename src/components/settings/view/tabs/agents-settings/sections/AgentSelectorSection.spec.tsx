import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AgentProvider } from '../../../../types/types';
import type { AgentContextByProvider } from '../types';

import AgentSelectorSection from './AgentSelectorSection';

const authStatus = { authenticated: false, loading: false, email: null, method: null, error: null };

const agentContextById: AgentContextByProvider = {
  claude: { authStatus: { ...authStatus, authenticated: true }, onLogin: vi.fn() },
  codex: { authStatus, onLogin: vi.fn() },
  antigravity: { authStatus, onLogin: vi.fn() },
};

describe('AgentSelectorSection', () => {
  it('renders a pill for each agent and shows a status dot for authenticated ones', () => {
    const agents: AgentProvider[] = ['claude', 'codex', 'antigravity'];

    render(
      <AgentSelectorSection
        agents={agents}
        selectedAgent="claude"
        onSelectAgent={vi.fn()}
        agentContextById={agentContextById}
      />,
    );

    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Antigravity')).toBeInTheDocument();
  });

  it('calls onSelectAgent when a pill is clicked', async () => {
    const user = userEvent.setup();
    const onSelectAgent = vi.fn();

    render(
      <AgentSelectorSection
        agents={['claude', 'codex']}
        selectedAgent="claude"
        onSelectAgent={onSelectAgent}
        agentContextById={agentContextById}
      />,
    );

    await user.click(screen.getByText('Codex'));
    expect(onSelectAgent).toHaveBeenCalledWith('codex');
  });

  it('does not render a status dot for unauthenticated agents', () => {
    render(
      <AgentSelectorSection
        agents={['codex']}
        selectedAgent="codex"
        onSelectAgent={vi.fn()}
        agentContextById={agentContextById}
      />,
    );

    const pill = screen.getByText('Codex').closest('button, div');
    expect(pill?.querySelector('.rounded-full')).toBeNull();
  });
});
