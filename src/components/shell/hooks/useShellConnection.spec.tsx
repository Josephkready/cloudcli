import { useRef } from 'react';
import type { MutableRefObject } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';

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
