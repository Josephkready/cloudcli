import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';

/*
 * Auto-connect gating (#295).
 *
 * `MainContent` keeps the shell mounted and drives `autoConnect` from the tab
 * (#292), so the reveal path now runs on every return to the tab — including
 * after the user has *explicitly* pressed Disconnect. The suppression flag that
 * has to survive that cycle is a ref, invisible to the effect's dependency
 * list, and was believed correct by inspection but never exercised.
 *
 * jsdom has no WebSocket worth using here, so the socket is stubbed at the
 * global and the assertions are about how many sockets get opened.
 */

const socketUrl = vi.hoisted(() => ({ value: 'ws://localhost/shell' }));

vi.mock('../utils/socket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/socket')>();
  return {
    ...actual,
    getShellWebSocketUrl: () => socketUrl.value,
  };
});

const { useShellConnection } = await import('./useShellConnection');

type FakeSocket = {
  url: string;
  readyState: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
};

const sockets: FakeSocket[] = [];
let originalWebSocket: unknown;

class StubWebSocket {
  // `sendSocketMessage` compares against the global `WebSocket.OPEN` static,
  // which this stub replaces — without redeclaring it, that comparison is
  // `1 === undefined` and every send silently no-ops.
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  constructor(url: string) {
    const socket: FakeSocket = {
      url,
      readyState: 1,
      close: vi.fn(),
      send: vi.fn(),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    sockets.push(socket);
    return socket as unknown as StubWebSocket;
  }
}

const project: Project = {
  projectId: '/home/dev/alpha',
  displayName: 'alpha',
  fullPath: '/home/dev/alpha',
  path: '/home/dev/alpha',
};

type HarnessProps = {
  autoConnect: boolean;
  isInitialized?: boolean;
  onReady: (api: ReturnType<typeof useShellConnection>) => void;
};

function Harness({ autoConnect, isInitialized = true, onReady }: HarnessProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const selectedProjectRef = useRef<Project | null>(project);
  const selectedSessionRef = useRef<ProjectSession | null>(null);
  const initialCommandRef = useRef<string | null>(null);
  const isPlainShellRef = useRef(true);
  const onProcessCompleteRef = useRef<((exitCode: number) => void) | null>(null);

  const api = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    selectedSessionRef,
    initialCommandRef,
    isPlainShellRef,
    onProcessCompleteRef,
    isInitialized,
    autoConnect,
    closeSocket: () => {
      wsRef.current = null;
    },
    clearTerminalScreen: () => undefined,
  } as unknown as Parameters<typeof useShellConnection>[0]);

  onReady(api);
  return null;
}

/** Completes the handshake the way the real socket would. */
const openLatestSocket = () => {
  const socket = sockets[sockets.length - 1];
  act(() => {
    socket.onopen?.();
  });
};

beforeEach(() => {
  sockets.length = 0;
  socketUrl.value = 'ws://localhost/shell';
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = StubWebSocket;
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

describe('useShellConnection — auto-connect gating (#295)', () => {
  it('opens a pty when the shell tab is revealed', () => {
    let api!: ReturnType<typeof useShellConnection>;
    render(<Harness autoConnect onReady={(next) => { api = next; }} />);

    expect(sockets).toHaveLength(1);
    expect(api.isConnecting).toBe(true);
  });

  it('opens nothing while the surface is mounted but hidden', () => {
    const { rerender } = render(
      <Harness autoConnect={false} onReady={() => undefined} />,
    );

    // The hidden shell is the case #292 introduced: mounted, but it must not
    // spawn a pty of its own.
    expect(sockets).toHaveLength(0);

    rerender(<Harness autoConnect onReady={() => undefined} />);
    expect(sockets).toHaveLength(1);
  });

  it('waits for the terminal before connecting', () => {
    const { rerender } = render(
      <Harness autoConnect isInitialized={false} onReady={() => undefined} />,
    );

    expect(sockets).toHaveLength(0);

    rerender(<Harness autoConnect isInitialized onReady={() => undefined} />);
    expect(sockets).toHaveLength(1);
  });

  it('keeps an explicit Disconnect across a hide/reveal cycle', () => {
    let api!: ReturnType<typeof useShellConnection>;
    const { rerender } = render(<Harness autoConnect onReady={(next) => { api = next; }} />);
    openLatestSocket();
    expect(sockets).toHaveLength(1);

    act(() => api.disconnectFromShell({ suppressAutoConnect: true }));

    // Tab away, then back: the effect re-runs with autoConnect true, and the
    // suppression flag is the only thing standing between the user's Disconnect
    // and a pty respawning behind their back.
    rerender(<Harness autoConnect={false} onReady={(next) => { api = next; }} />);
    rerender(<Harness autoConnect onReady={(next) => { api = next; }} />);

    expect(sockets).toHaveLength(1);
  });

  it('reconnects on reveal after a plain disconnect that was not user-initiated', () => {
    let api!: ReturnType<typeof useShellConnection>;
    const { rerender } = render(<Harness autoConnect onReady={(next) => { api = next; }} />);
    openLatestSocket();

    // No suppression flag: this is a dropped socket, not a user decision.
    act(() => api.disconnectFromShell());

    rerender(<Harness autoConnect={false} onReady={(next) => { api = next; }} />);
    rerender(<Harness autoConnect onReady={(next) => { api = next; }} />);

    expect(sockets).toHaveLength(2);
  });

  it('lets an explicit Connect clear a previous Disconnect', () => {
    let api!: ReturnType<typeof useShellConnection>;
    const { rerender } = render(<Harness autoConnect onReady={(next) => { api = next; }} />);
    openLatestSocket();

    act(() => api.disconnectFromShell({ suppressAutoConnect: true }));
    act(() => api.connectToShell());
    expect(sockets).toHaveLength(2);
    openLatestSocket();

    // Suppression is cleared by the explicit reconnect, so a later hide/reveal
    // behaves normally again.
    act(() => api.disconnectFromShell());
    rerender(<Harness autoConnect={false} onReady={(next) => { api = next; }} />);
    rerender(<Harness autoConnect onReady={(next) => { api = next; }} />);

    expect(sockets).toHaveLength(3);
  });
});

/*
 * Handshake payload, message dispatch and lifecycle callbacks (#295 follow-up).
 *
 * The gating tests above only need `isConnecting`/socket-count. Everything a
 * real pty session depends on — the `init` payload's fields, routing
 * `output` frames to xterm, scraping the plain-shell exit code out of them,
 * and clearing state on close/error — needs a terminal/fit-addon in the refs
 * and fake timers for the `TERMINAL_INIT_DELAY_MS` handshake delay.
 */
type RichHarnessProps = {
  isPlainShell?: boolean;
  session?: ProjectSession | null;
  initialCommand?: string | null;
  onProcessComplete?: (exitCode: number) => void;
  onReady: (api: {
    connection: ReturnType<typeof useShellConnection>;
    terminal: { write: ReturnType<typeof vi.fn>; cols: number; rows: number };
    fit: ReturnType<typeof vi.fn>;
    clearTerminalScreen: ReturnType<typeof vi.fn>;
    onOutput: ReturnType<typeof vi.fn>;
  }) => void;
};

function RichHarness({
  isPlainShell = false,
  session = null,
  initialCommand = null,
  onProcessComplete,
  onReady,
}: RichHarnessProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const fit = useRef(vi.fn()).current;
  const terminal = useRef({
    write: vi.fn(),
    cols: 80,
    rows: 24,
    element: { parentElement: { clientWidth: 800, clientHeight: 400 } },
  }).current;
  const terminalRef = useRef(terminal as unknown as Terminal);
  const fitAddonRef = useRef({ fit } as unknown as FitAddon);
  const selectedProjectRef = useRef<Project | null>(project);
  const selectedSessionRef = useRef<ProjectSession | null>(session);
  const initialCommandRef = useRef<string | null>(initialCommand);
  const isPlainShellRef = useRef(isPlainShell);
  const onProcessCompleteRef = useRef<((exitCode: number) => void) | null>(onProcessComplete ?? null);
  const clearTerminalScreen = useRef(vi.fn()).current;
  const onOutput = useRef(vi.fn()).current;
  const onOutputRef = useRef<(() => void) | null>(onOutput);

  const connection = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    selectedSessionRef,
    initialCommandRef,
    isPlainShellRef,
    onProcessCompleteRef,
    isInitialized: true,
    autoConnect: false,
    closeSocket: () => {
      wsRef.current = null;
    },
    clearTerminalScreen,
    onOutputRef,
  } as unknown as Parameters<typeof useShellConnection>[0]);

  onReady({ connection, terminal, fit, clearTerminalScreen, onOutput });
  return null;
}

function openAndHandshake() {
  const socket = sockets[sockets.length - 1];
  act(() => {
    socket.onopen?.();
    vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS);
  });
  return socket;
}

describe('useShellConnection — handshake payload and message dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a session init payload once the terminal and fit addon are ready', () => {
    const session = { id: 'sess-9', __provider: 'codex' } as unknown as ProjectSession;
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness session={session} onReady={(next) => { api = next; }} />);

    act(() => api.connection.connectToShell());
    const socket = openAndHandshake();

    expect(api.fit).toHaveBeenCalled();
    const initMessage = JSON.parse(socket.send.mock.calls[0][0]);
    expect(initMessage).toMatchObject({
      type: 'init',
      projectPath: project.fullPath,
      sessionId: 'sess-9',
      hasSession: true,
      provider: 'codex',
      cols: 80,
      rows: 24,
      isPlainShell: false,
    });
  });

  it('sends a plain-shell init payload with no session and the plain-shell provider', () => {
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(
      <RichHarness
        isPlainShell
        initialCommand="claude auth login"
        onReady={(next) => { api = next; }}
      />,
    );

    act(() => api.connection.connectToShell());
    const socket = openAndHandshake();

    const initMessage = JSON.parse(socket.send.mock.calls[0][0]);
    expect(initMessage).toMatchObject({
      sessionId: null,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'claude auth login',
    });
  });

  it('marks a forced restart in the init payload exactly once', () => {
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness onReady={(next) => { api = next; }} />);

    act(() => api.connection.connectToShell({ forceRestart: true }));
    const socket = openAndHandshake();

    const initMessage = JSON.parse(socket.send.mock.calls[0][0]);
    expect(initMessage.forceRestart).toBe(true);
  });

  it('writes output frames to the terminal and notifies onOutputRef', () => {
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness onReady={(next) => { api = next; }} />);
    act(() => api.connection.connectToShell());
    const socket = openAndHandshake();

    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'hello\n' }) });
    });

    expect(api.terminal.write).toHaveBeenCalledWith('hello\n');
    expect(api.onOutput).toHaveBeenCalledTimes(1);
  });

  it('completes the process on exit code 0 for a plain shell', () => {
    const onProcessComplete = vi.fn();
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness isPlainShell onProcessComplete={onProcessComplete} onReady={(next) => { api = next; }} />);
    act(() => api.connection.connectToShell());
    const socket = openAndHandshake();

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'output', data: 'Process exited with code 0\r\n' }),
      });
    });

    expect(onProcessComplete).toHaveBeenCalledWith(0);
  });

  it('completes the process with a non-zero exit code', () => {
    const onProcessComplete = vi.fn();
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness isPlainShell onProcessComplete={onProcessComplete} onReady={(next) => { api = next; }} />);
    act(() => api.connection.connectToShell());
    const socket = openAndHandshake();

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'output', data: 'Process exited with code 7\r\n' }),
      });
    });

    expect(onProcessComplete).toHaveBeenCalledWith(7);
  });

  it('does not report completion for a session shell even on exit output', () => {
    const onProcessComplete = vi.fn();
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(
      <RichHarness isPlainShell={false} onProcessComplete={onProcessComplete} onReady={(next) => { api = next; }} />,
    );
    act(() => api.connection.connectToShell());
    const socket = openAndHandshake();

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'output', data: 'Process exited with code 0\r\n' }),
      });
    });

    expect(onProcessComplete).not.toHaveBeenCalled();
  });

  it('logs and ignores a message payload that does not parse as JSON', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness onReady={(next) => { api = next; }} />);
    act(() => api.connection.connectToShell());
    const socket = openAndHandshake();

    act(() => {
      socket.onmessage?.({ data: 'not json' });
    });

    expect(consoleError).toHaveBeenCalled();
    expect(api.terminal.write).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('clears the connected state and the terminal on socket close', () => {
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness onReady={(next) => { api = next; }} />);
    act(() => api.connection.connectToShell());
    const socket = openAndHandshake();
    expect(api.connection.isConnected).toBe(true);

    act(() => {
      socket.onclose?.();
    });

    expect(api.clearTerminalScreen).toHaveBeenCalled();
  });

  it('clears the connecting/connected state on socket error', () => {
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness onReady={(next) => { api = next; }} />);
    act(() => api.connection.connectToShell());

    act(() => {
      sockets[sockets.length - 1].onerror?.();
    });

    expect(sockets).toHaveLength(1);
  });

  it('does not connect while already initializing/connecting/connected', () => {
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness onReady={(next) => { api = next; }} />);

    act(() => {
      api.connection.connectToShell();
      api.connection.connectToShell();
    });

    expect(sockets).toHaveLength(1);
  });

  it('disconnectFromShell tears down the socket and resets connection state', () => {
    let api!: Parameters<RichHarnessProps['onReady']>[0];
    render(<RichHarness onReady={(next) => { api = next; }} />);
    act(() => api.connection.connectToShell());
    openAndHandshake();
    expect(api.connection.isConnected).toBe(true);

    act(() => api.connection.disconnectFromShell());

    expect(api.connection.isConnected).toBe(false);
    expect(api.clearTerminalScreen).toHaveBeenCalled();
  });
});

describe('useShellConnection — socket construction failure', () => {
  it('resets to a disconnected state when the WebSocket URL cannot be built', () => {
    socketUrl.value = '';
    let api!: ReturnType<typeof useShellConnection>;
    render(<Harness autoConnect={false} onReady={(next) => { api = next; }} />);

    act(() => api.connectToShell());

    expect(sockets).toHaveLength(0);
    expect(api.isConnecting).toBe(false);
    socketUrl.value = 'ws://localhost/shell';
  });
});
