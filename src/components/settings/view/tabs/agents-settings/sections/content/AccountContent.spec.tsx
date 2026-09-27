import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AuthStatus } from '../../../../../types/types';

import AccountContent from './AccountContent';

const baseStatus: AuthStatus = {
  authenticated: false,
  loading: false,
  email: null,
  method: null,
  error: null,
};

describe('AccountContent', () => {
  it('shows not-connected state and login button for claude', async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn();

    render(<AccountContent agent="claude" authStatus={baseStatus} onLogin={onLogin} />);

    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();

    const button = screen.getByRole('button');
    await user.click(button);
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it('shows checking state while loading', () => {
    render(
      <AccountContent
        agent="codex"
        authStatus={{ authenticated: false, loading: true, email: null, method: null, error: null }}
        onLogin={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/checking/i).length).toBeGreaterThan(0);
  });

  it('shows connected state with email for antigravity when authenticated', () => {
    render(
      <AccountContent
        agent="antigravity"
        authStatus={{ authenticated: true, loading: false, email: 'me@example.com', method: null, error: null }}
        onLogin={vi.fn()}
      />,
    );

    expect(screen.getByText('Antigravity')).toBeInTheDocument();
    expect(screen.getByText(/me@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-?login|re-?authenticate/i })).toBeInTheDocument();
  });

  it('hides the login button entirely when auth method is api_key', () => {
    render(
      <AccountContent
        agent="claude"
        authStatus={{ authenticated: true, loading: false, method: 'api_key', email: null, error: null }}
        onLogin={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders an error message when authStatus has an error', () => {
    render(
      <AccountContent
        agent="codex"
        authStatus={{ authenticated: false, loading: false, error: 'network failure', email: null, method: null }}
        onLogin={vi.fn()}
      />,
    );

    expect(screen.getByText(/network failure/)).toBeInTheDocument();
  });
});
