import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';

/*
 * `useShellRuntime` is pure composition: it owns the shared refs, builds
 * `closeSocket`, and wires `useShellTerminal`/`useShellConnection` together
 * with three small effects (restart, project cleared, session changed). Both
 * sub-hooks have their own dedicated specs, so they are stubbed here to
 * isolate exactly that wiring.
 */

const terminalHook = vi.hoisted(() => ({
  disposeTerminal: vi.fn(),
  clearTerminalScreen: vi.fn(),
  lastOptions: null as unknown,
}));

const connectionHook = vi.hoisted(() => ({
  disconnectFromShell: vi.fn(),
  connectToShell: vi.fn(),
  lastOptions: null as unknown,
}));

vi.mock('./useShellTerminal', () => ({
  useShellTerminal: (options: unknown) => {
    terminalHook.lastOptions = options;
    return {
      isInitialized: true,
      clearTerminalScreen: terminalHook.clearTerminalScreen,
      disposeTerminal: terminalHook.disposeTerminal,
    };
  },
}));

vi.mock('./useShellConnection', () => ({
  useShellConnection: (options: unknown) => {
    connectionHook.lastOptions = options;
    return {
      isConnected: false,
      isConnecting: false,
      connectToShell: connectionHook.connectToShell,
      disconnectFromShell: connectionHook.disconnectFromShell,
    };
  },
}));

const { useShellRuntime } = await import('./useShellRuntime');

const PROJECT: Project = {
  projectId: '/tmp/project',
  displayName: 'project',
  fullPath: '/tmp/project',
  path: '/tmp/project',
};

function Harness({
  isRestarting = false,
  selectedProject = PROJECT as Project | null,
  selectedSession = null as ProjectSession | null,
}) {
  useShellRuntime({
    selectedProject,
    selectedSession,
    initialCommand: null,
    isPlainShell: false,
    minimal: false,
    autoConnect: false,
    isRestarting,
    isActive: true,
    onProcessComplete: null,
  });
  return null;
}

beforeEach(() => {
  terminalHook.disposeTerminal.mockClear();
  terminalHook.clearTerminalScreen.mockClear();
  connectionHook.disconnectFromShell.mockClear();
  connectionHook.connectToShell.mockClear();
});

describe('useShellRuntime — wiring', () => {
  it('tears down the connection and terminal when a restart is requested', () => {
    render(<Harness isRestarting />);

    expect(connectionHook.disconnectFromShell).toHaveBeenCalledTimes(1);
    expect(terminalHook.disposeTerminal).toHaveBeenCalledTimes(1);
  });

  it('does nothing extra when not restarting', () => {
    render(<Harness />);

    expect(connectionHook.disconnectFromShell).not.toHaveBeenCalled();
    expect(terminalHook.disposeTerminal).not.toHaveBeenCalled();
  });

  it('tears down when the project is cleared', () => {
    const { rerender } = render(<Harness selectedProject={PROJECT} />);
    expect(connectionHook.disconnectFromShell).not.toHaveBeenCalled();

    rerender(<Harness selectedProject={null} />);

    expect(connectionHook.disconnectFromShell).toHaveBeenCalledTimes(1);
    expect(terminalHook.disposeTerminal).toHaveBeenCalledTimes(1);
  });

  it('disconnects when the session id changes after the terminal is initialized', () => {
    const sessionA = { id: 'a' } as ProjectSession;
    const sessionB = { id: 'b' } as ProjectSession;
    const { rerender } = render(<Harness selectedSession={sessionA} />);
    expect(connectionHook.disconnectFromShell).not.toHaveBeenCalled();

    rerender(<Harness selectedSession={sessionB} />);

    expect(connectionHook.disconnectFromShell).toHaveBeenCalledTimes(1);
  });

  it('does not disconnect when the session id is unchanged', () => {
    const sessionA = { id: 'a' } as ProjectSession;
    const { rerender } = render(<Harness selectedSession={sessionA} />);

    rerender(<Harness selectedSession={sessionA} />);

    expect(connectionHook.disconnectFromShell).not.toHaveBeenCalled();
  });

  it('builds a closeSocket that closes an open socket and clears the ref', () => {
    render(<Harness />);

    const options = terminalHook.lastOptions as { wsRef: { current: WebSocket | null }; closeSocket: () => void };
    const socket = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
    options.wsRef.current = socket;

    act(() => {
      options.closeSocket();
    });

    expect((socket as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect(options.wsRef.current).toBeNull();
  });

  it('closeSocket is a no-op when there is no active socket', () => {
    render(<Harness />);

    const options = terminalHook.lastOptions as { wsRef: { current: WebSocket | null }; closeSocket: () => void };
    options.wsRef.current = null;

    expect(() => {
      act(() => {
        options.closeSocket();
      });
    }).not.toThrow();
  });

  it('closeSocket does not call close on an already-closed socket', () => {
    render(<Harness />);

    const options = terminalHook.lastOptions as { wsRef: { current: WebSocket | null }; closeSocket: () => void };
    const socket = { readyState: WebSocket.CLOSED, close: vi.fn() } as unknown as WebSocket;
    options.wsRef.current = socket;

    act(() => {
      options.closeSocket();
    });

    expect((socket as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
    expect(options.wsRef.current).toBeNull();
  });
});
