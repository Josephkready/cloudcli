import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ProviderMcpServer } from '../types';

import McpServers from './McpServers';

const { useMcpServers } = vi.hoisted(() => ({ useMcpServers: vi.fn() }));
vi.mock('../hooks/useMcpServers', () => ({ useMcpServers }));

function makeServer(overrides: Partial<ProviderMcpServer> = {}): ProviderMcpServer {
  return {
    provider: 'claude',
    name: 'my-server',
    scope: 'user',
    transport: 'stdio',
    command: 'run-thing',
    args: ['--flag'],
    env: {},
    envVars: [],
    headers: {},
    envHttpHeaders: {},
    ...overrides,
  };
}

function baseHookState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    servers: [],
    isLoading: false,
    isLoadingProjectScopes: false,
    loadError: null,
    deleteError: null,
    saveStatus: null,
    deleteServer: vi.fn(),
    refreshServers: vi.fn(),
    ...overrides,
  };
}

describe('McpServers', () => {
  beforeEach(() => {
    useMcpServers.mockReset();
  });

  it('shows a loading state while there are no servers yet', () => {
    useMcpServers.mockReturnValue(baseHookState({ isLoading: true }));
    render(<McpServers selectedProvider="claude" currentProjects={[]} />);

    expect(screen.getByText('Loading MCP servers...')).toBeInTheDocument();
  });

  it('renders an empty state once loading finishes with no servers', () => {
    useMcpServers.mockReturnValue(baseHookState());
    render(<McpServers selectedProvider="claude" currentProjects={[]} />);

    expect(screen.queryByText('Loading MCP servers...')).not.toBeInTheDocument();
  });

  it('renders a non-managed server with its config details and action buttons', () => {
    useMcpServers.mockReturnValue(baseHookState({
      servers: [makeServer({ env: { API_KEY: 'super-secret-value' } })],
    }));
    render(<McpServers selectedProvider="claude" currentProjects={[]} />);

    expect(screen.getByText('my-server')).toBeInTheDocument();
    expect(screen.getByText('run-thing')).toBeInTheDocument();
    expect(screen.getByText('--flag')).toBeInTheDocument();
    // env values are masked, not shown raw
    expect(screen.queryByText(/super-secret-value/)).not.toBeInTheDocument();
    expect(screen.getByText(/API_KEY=/)).toBeInTheDocument();
  });

  it('renders a managed (cloudcli-prefixed) server read-only, without edit/delete', () => {
    useMcpServers.mockReturnValue(baseHookState({
      servers: [makeServer({ name: 'cloudcli-browser' })],
    }));
    render(<McpServers selectedProvider="claude" currentProjects={[]} />);

    expect(screen.getByText('cloudcli-browser')).toBeInTheDocument();
    expect(screen.getByText('Managed')).toBeInTheDocument();
    expect(screen.queryByText('run-thing')).not.toBeInTheDocument();
  });

  it('invokes deleteServer from the row action button', async () => {
    const deleteServer = vi.fn();
    const server = makeServer();
    useMcpServers.mockReturnValue(baseHookState({ servers: [server], deleteServer }));
    const user = userEvent.setup();
    render(<McpServers selectedProvider="claude" currentProjects={[]} />);

    await user.click(screen.getByTitle('Delete server'));
    expect(deleteServer).toHaveBeenCalledWith(server);
  });

  it('shows the load/delete error banner when present', () => {
    useMcpServers.mockReturnValue(baseHookState({ loadError: 'could not load servers' }));
    render(<McpServers selectedProvider="claude" currentProjects={[]} />);

    expect(screen.getByText('could not load servers')).toBeInTheDocument();
  });

  it('prefers the delete error over the load error when both are present', () => {
    useMcpServers.mockReturnValue(baseHookState({ loadError: 'load broke', deleteError: 'delete broke' }));
    render(<McpServers selectedProvider="claude" currentProjects={[]} />);

    expect(screen.getByText('delete broke')).toBeInTheDocument();
    expect(screen.queryByText('load broke')).not.toBeInTheDocument();
  });

  it('shows the codex-specific help card only for the codex provider', () => {
    useMcpServers.mockReturnValue(baseHookState());
    const { rerender } = render(<McpServers selectedProvider="codex" currentProjects={[]} />);
    expect(screen.getByText('About Codex MCP')).toBeInTheDocument();

    rerender(<McpServers selectedProvider="claude" currentProjects={[]} />);
    expect(screen.queryByText('About Codex MCP')).not.toBeInTheDocument();
  });

  it('shows a save-status success message', () => {
    useMcpServers.mockReturnValue(baseHookState({ saveStatus: 'success' }));
    render(<McpServers selectedProvider="claude" currentProjects={[]} />);

    expect(screen.getByText('Settings saved successfully!')).toBeInTheDocument();
  });

  it('shows a refreshing indicator while project scopes are still loading', () => {
    useMcpServers.mockReturnValue(baseHookState({ isLoadingProjectScopes: true }));
    render(<McpServers selectedProvider="claude" currentProjects={[]} />);

    expect(screen.getByText('Refreshing project scopes...')).toBeInTheDocument();
  });
});
