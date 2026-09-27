import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ShellHeader from './ShellHeader';

function baseProps() {
  return {
    isConnected: false,
    isInitialized: true,
    isRestarting: false,
    hasSession: false,
    sessionDisplayNameShort: null as string | null,
    onDisconnect: vi.fn(),
    onRestart: vi.fn(),
    statusNewSessionText: 'New session',
    statusInitializingText: 'Initializing…',
    statusRestartingText: 'Restarting…',
    disconnectLabel: 'Disconnect',
    disconnectTitle: 'Disconnect the shell',
    restartLabel: 'Restart',
    restartTitle: 'Restart the shell',
    disableRestart: false,
  };
}

describe('ShellHeader', () => {
  it('shows the new-session status and omits the disconnect button when not connected', () => {
    render(<ShellHeader {...baseProps()} />);

    expect(screen.getByText('New session')).toBeInTheDocument();
    expect(screen.queryByText('Disconnect')).not.toBeInTheDocument();
    expect(screen.getByText('Restart')).toBeInTheDocument();
  });

  it('shows the session name instead of the new-session status when a session is attached', () => {
    render(
      <ShellHeader
        {...baseProps()}
        hasSession
        sessionDisplayNameShort="my-session"
      />,
    );

    expect(screen.getByText('(my-session...)')).toBeInTheDocument();
    expect(screen.queryByText('New session')).not.toBeInTheDocument();
  });

  it('shows initializing and restarting badges', () => {
    render(<ShellHeader {...baseProps()} isInitialized={false} isRestarting />);

    expect(screen.getByText('Initializing…')).toBeInTheDocument();
    expect(screen.getByText('Restarting…')).toBeInTheDocument();
  });

  it('shows the disconnect button only while connected and wires up the click handler', async () => {
    const user = userEvent.setup();
    const onDisconnect = vi.fn();
    render(<ShellHeader {...baseProps()} isConnected onDisconnect={onDisconnect} />);

    const disconnectButton = screen.getByRole('button', { name: /disconnect/i });
    await user.click(disconnectButton);

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('invokes onRestart and disables the button when disableRestart is set', async () => {
    const user = userEvent.setup();
    const onRestart = vi.fn();
    const { rerender } = render(<ShellHeader {...baseProps()} onRestart={onRestart} />);

    const restartButton = screen.getByRole('button', { name: /restart/i });
    expect(restartButton).not.toBeDisabled();
    await user.click(restartButton);
    expect(onRestart).toHaveBeenCalledTimes(1);

    rerender(<ShellHeader {...baseProps()} onRestart={onRestart} disableRestart />);
    expect(screen.getByRole('button', { name: /restart/i })).toBeDisabled();
  });

  it('shows a green status dot when connected and red otherwise', () => {
    const { container, rerender } = render(<ShellHeader {...baseProps()} isConnected={false} />);
    expect(container.querySelector('.bg-red-500')).not.toBeNull();

    rerender(<ShellHeader {...baseProps()} isConnected />);
    expect(container.querySelector('.bg-green-500')).not.toBeNull();
  });
});
