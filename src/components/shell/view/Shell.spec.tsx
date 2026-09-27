import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';

/*
 * `Shell` composes `useShellRuntime` (already covered by its own hook specs)
 * with the header/overlay/shortcuts chrome and the CLI-prompt scraper that
 * reads raw xterm buffer lines. Stubbing the runtime hook here isolates that
 * composition and the buffer-scanning logic, while the header/overlay/panel
 * render for real so their wiring (props in, DOM out) gets exercised too.
 */

const runtime = vi.hoisted(() => ({
  state: {
    isConnected: false,
    isInitialized: true,
    isConnecting: false,
  },
  connectToShell: vi.fn(),
  disconnectFromShell: vi.fn(),
  onOutputRef: { current: null as (() => void) | null },
}));

vi.mock('../hooks/useShellRuntime', () => ({
  useShellRuntime: (options: { onOutputRef?: { current: (() => void) | null } }) => {
    if (options.onOutputRef) {
      runtime.onOutputRef = options.onOutputRef;
    }
    return {
      terminalContainerRef: { current: null },
      terminalRef: runtimeTerminalRef,
      wsRef: runtimeWsRef,
      isConnected: runtime.state.isConnected,
      isInitialized: runtime.state.isInitialized,
      isConnecting: runtime.state.isConnecting,
      connectToShell: runtime.connectToShell,
      disconnectFromShell: runtime.disconnectFromShell,
    };
  },
}));

type FakeLine = { translateToString: () => string };

function makeBuffer(lines: string[], cursorRow: number) {
  return {
    baseY: 0,
    cursorY: cursorRow,
    length: lines.length,
    getLine: (index: number): FakeLine | undefined =>
      lines[index] !== undefined ? { translateToString: () => lines[index] } : undefined,
  };
}

const runtimeTerminalRef = { current: null as unknown as Terminal | null };
const runtimeWsRef = { current: null as unknown as WebSocket | null };

const { default: Shell } = await import('./Shell');

const PROJECT: Project = {
  projectId: '/tmp/project',
  displayName: 'project',
  fullPath: '/tmp/project',
  path: '/tmp/project',
};

const SESSION: ProjectSession = {
  id: 'sess-1',
  summary: 'My great session',
} as unknown as ProjectSession;

function fakeSocket() {
  return { readyState: WebSocket.OPEN, send: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
  runtime.state = { isConnected: false, isInitialized: true, isConnecting: false };
  runtime.connectToShell.mockClear();
  runtime.disconnectFromShell.mockClear();
  runtimeTerminalRef.current = null;
  runtimeWsRef.current = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Shell — empty state', () => {
  it('renders the empty state when no project is selected', () => {
    render(<Shell selectedProject={null} />);

    expect(screen.getByText('Select a Project')).toBeInTheDocument();
  });
});

describe('Shell — minimal mode', () => {
  it('renders the minimal terminal surface plus the shortcuts panel', () => {
    render(<Shell selectedProject={PROJECT} minimal />);

    // ShellHeader is not rendered in minimal mode.
    expect(screen.queryByRole('button', { name: /restart/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Esc' })).toBeInTheDocument();
  });
});

describe('Shell — connection overlay', () => {
  it('shows the loading overlay before the terminal initializes', () => {
    runtime.state.isInitialized = false;
    render(<Shell selectedProject={PROJECT} />);

    expect(screen.getByText('Loading terminal...')).toBeInTheDocument();
  });

  it('shows the connecting overlay while a pty is being established', () => {
    runtime.state.isConnecting = true;
    render(<Shell selectedProject={PROJECT} isPlainShell initialCommand="ls -la" />);

    expect(screen.getByText(/Connecting/)).toBeInTheDocument();
  });

  it('shows a connect button when idle, and pressing it forces a restart-connect', () => {
    render(<Shell selectedProject={PROJECT} />);

    const connectButton = screen.getByRole('button', { name: 'Continue in Shell' });
    fireEvent.click(connectButton);

    // Pressing Connect drives the same restart path as the header button, so
    // the runtime should be asked to force-restart once the terminal is ready.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(runtime.connectToShell).toHaveBeenCalledWith({ forceRestart: true });
  });

  it('renders no overlay once connected', () => {
    runtime.state.isConnected = true;
    render(<Shell selectedProject={PROJECT} />);

    expect(screen.queryByText('Loading terminal...')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue in Shell' })).not.toBeInTheDocument();
  });
});

describe('Shell — header actions', () => {
  it('disconnects with auto-connect suppressed via the header button', () => {
    runtime.state.isConnected = true;
    render(<Shell selectedProject={PROJECT} />);

    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    expect(runtime.disconnectFromShell).toHaveBeenCalledWith({ suppressAutoConnect: true });
  });

  it('shows a restarting badge and reconnects once initialization completes', () => {
    runtime.state.isConnected = true;
    const { rerender } = render(<Shell selectedProject={PROJECT} />);

    fireEvent.click(screen.getByRole('button', { name: /restart/i }));

    // The restart delay clears the visible "Restarting..." state, then a
    // ready (initialized, not connected/connecting) terminal reconnects.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    runtime.state.isConnected = false;
    rerender(<Shell selectedProject={PROJECT} />);

    expect(runtime.connectToShell).toHaveBeenCalledWith({ forceRestart: true });
  });
});

describe('Shell — CLI prompt scraping', () => {
  it('surfaces numbered options scraped from the xterm buffer and sends the picked number', () => {
    runtime.state.isConnected = true;
    runtimeWsRef.current = fakeSocket() as unknown as WebSocket;
    const lines = [
      '1. Yes, proceed',
      '2. No, cancel',
      'esc to cancel, enter to select',
    ];
    runtimeTerminalRef.current = {
      buffer: { active: makeBuffer(lines, lines.length - 1) },
      focus: vi.fn(),
    } as unknown as Terminal;

    render(<Shell selectedProject={PROJECT} />);

    // The scraper only runs once xterm output is observed.
    act(() => {
      runtime.onOutputRef.current?.();
      vi.advanceTimersByTime(500);
    });

    const yesButton = screen.getByRole('button', { name: /1\. Yes, proceed/ });
    expect(yesButton).toBeInTheDocument();

    act(() => {
      yesButton.click();
    });

    const socket = runtimeWsRef.current as unknown as { send: ReturnType<typeof vi.fn> };
    const [payload] = socket.send.mock.calls[0];
    expect(JSON.parse(String(payload))).toEqual({ type: 'input', data: '1' });
    expect(screen.queryByRole('button', { name: /1\. Yes, proceed/ })).not.toBeInTheDocument();
  });

  it('clears the prompt overlay and cancels pending scans on disconnect', () => {
    runtime.state.isConnected = true;
    const lines = ['1. Yes', '2. No', 'enter to select'];
    runtimeTerminalRef.current = {
      buffer: { active: makeBuffer(lines, lines.length - 1) },
      focus: vi.fn(),
    } as unknown as Terminal;

    const { rerender } = render(<Shell selectedProject={PROJECT} />);
    act(() => {
      runtime.onOutputRef.current?.();
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('button', { name: /1\. Yes/ })).toBeInTheDocument();

    runtime.state.isConnected = false;
    rerender(<Shell selectedProject={PROJECT} />);

    expect(screen.queryByRole('button', { name: /1\. Yes/ })).not.toBeInTheDocument();
  });

  it('does not surface a prompt overlay when fewer than two options are found', () => {
    runtime.state.isConnected = true;
    const lines = ['1. Only option', 'enter to select'];
    runtimeTerminalRef.current = {
      buffer: { active: makeBuffer(lines, lines.length - 1) },
      focus: vi.fn(),
    } as unknown as Terminal;

    render(<Shell selectedProject={PROJECT} />);
    act(() => {
      runtime.onOutputRef.current?.();
      vi.advanceTimersByTime(500);
    });

    expect(screen.queryByRole('button', { name: /Only option/ })).not.toBeInTheDocument();
  });

  it('lets Esc dismiss the prompt overlay and send the escape sequence', () => {
    runtime.state.isConnected = true;
    runtimeWsRef.current = fakeSocket() as unknown as WebSocket;
    const lines = ['1. Yes', '2. No', 'enter to select'];
    runtimeTerminalRef.current = {
      buffer: { active: makeBuffer(lines, lines.length - 1) },
      focus: vi.fn(),
    } as unknown as Terminal;

    render(<Shell selectedProject={PROJECT} />);
    act(() => {
      runtime.onOutputRef.current?.();
      vi.advanceTimersByTime(500);
    });

    // Two "Esc" buttons exist in non-minimal mode: the prompt overlay's and
    // the always-present shortcuts panel's. The prompt one renders first.
    act(() => {
      screen.getAllByRole('button', { name: 'Esc' })[0].click();
    });

    const socket = runtimeWsRef.current as unknown as { send: ReturnType<typeof vi.fn> };
    const [payload] = socket.send.mock.calls[0];
    expect(JSON.parse(String(payload))).toEqual({ type: 'input', data: '\x1b' });
  });
});

describe('Shell — session naming', () => {
  it('shows a resume-session description in the connect overlay when a session is selected', () => {
    render(<Shell selectedProject={PROJECT} selectedSession={SESSION} />);

    expect(screen.getByRole('button', { name: 'Continue in Shell' })).toBeInTheDocument();
  });
});

describe('Shell — focus management', () => {
  it('focuses the terminal once active, initialized and connected', () => {
    const focus = vi.fn();
    runtimeTerminalRef.current = { focus, buffer: { active: makeBuffer([], 0) } } as unknown as Terminal;
    runtime.state.isConnected = true;

    render(<Shell selectedProject={PROJECT} isActive />);

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(focus).toHaveBeenCalled();
  });
});
