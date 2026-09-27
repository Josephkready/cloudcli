import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ShellConnectionOverlay from './ShellConnectionOverlay';

function baseProps() {
  return {
    mode: 'loading' as 'loading' | 'connect' | 'connecting',
    description: 'Start a new session',
    loadingLabel: 'Loading…',
    connectLabel: 'Connect',
    connectTitle: 'Connect the shell',
    connectingLabel: 'Connecting…',
    onConnect: vi.fn(),
  };
}

describe('ShellConnectionOverlay', () => {
  it('renders only the loading label in loading mode', () => {
    render(<ShellConnectionOverlay {...baseProps()} />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Start a new session')).not.toBeInTheDocument();
  });

  it('renders a connect button and description in connect mode, and wires the click', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(<ShellConnectionOverlay {...baseProps()} mode="connect" onConnect={onConnect} />);

    const button = screen.getByRole('button', { name: 'Connect' });
    expect(button).toHaveAttribute('title', 'Connect the shell');
    expect(screen.getByText('Start a new session')).toBeInTheDocument();

    await user.click(button);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('renders the connecting label and description without a button in connecting mode', () => {
    render(<ShellConnectionOverlay {...baseProps()} mode="connecting" />);

    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.getByText('Start a new session')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
