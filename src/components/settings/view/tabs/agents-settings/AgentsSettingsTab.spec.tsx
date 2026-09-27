import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./sections/AgentCategoryContentSection', () => ({
  default: (props: { selectedAgent: string; selectedCategory: string }) => (
    <div data-testid="content-section">
      {props.selectedAgent}:{props.selectedCategory}
    </div>
  ),
}));

import AgentsSettingsTab from './AgentsSettingsTab';
import type { AgentsSettingsTabProps } from './types';

const authStatus = { authenticated: false, loading: false, email: null, method: null, error: null };

const baseProps: AgentsSettingsTabProps = {
  providerAuthStatus: {
    claude: authStatus,
    codex: authStatus,
    antigravity: authStatus,
  },
  onProviderLogin: vi.fn(),
  claudePermissions: { allowedTools: [], disallowedTools: [], skipPermissions: false },
  onClaudePermissionsChange: vi.fn(),
  codexPermissionMode: 'default',
  onCodexPermissionModeChange: vi.fn(),
  projects: [],
};

describe('AgentsSettingsTab', () => {
  it('defaults to claude agent + account category and shows permissions tab', () => {
    render(<AgentsSettingsTab {...baseProps} />);

    expect(screen.getByText('claude:account')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /permissions/i })).toBeInTheDocument();
  });

  it('hides the permissions category tab for antigravity', async () => {
    const user = userEvent.setup();
    render(<AgentsSettingsTab {...baseProps} />);

    await user.click(screen.getByText('Antigravity'));

    expect(screen.queryByRole('tab', { name: /permissions/i })).not.toBeInTheDocument();
    expect(screen.getByText('antigravity:account')).toBeInTheDocument();
  });

  it('resets to account category when switching to antigravity while on permissions', async () => {
    const user = userEvent.setup();
    render(<AgentsSettingsTab {...baseProps} />);

    await user.click(screen.getByRole('tab', { name: /permissions/i }));
    expect(screen.getByText('claude:permissions')).toBeInTheDocument();

    await user.click(screen.getByText('Antigravity'));
    expect(screen.getByText('antigravity:account')).toBeInTheDocument();
  });

  it('switches category tab within the same agent', async () => {
    const user = userEvent.setup();
    render(<AgentsSettingsTab {...baseProps} />);

    await user.click(screen.getByRole('tab', { name: /mcp servers/i }));
    expect(screen.getByText('claude:mcp')).toBeInTheDocument();
  });
});
