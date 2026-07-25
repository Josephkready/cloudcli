import { Component, useCallback, useRef } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project } from '../../../types/app';

/*
 * Mount cost of the shell surface (#272).
 *
 * Two invariants worth protecting, both of which are about *when* xterm is
 * built rather than what it renders:
 *
 *   1. The chrome paints before the terminal is constructed. xterm plus four
 *      addons plus a WebGL context inside the click that opened the tab is what
 *      made the shell an order of magnitude slower to appear than its siblings.
 *   2. The terminal is built exactly once for as long as the surface is
 *      mounted. `MainContent` now hides the shell instead of unmounting it, so
 *      a rebuild on every reveal would quietly undo the fix.
 *
 * jsdom has no WebGL and no layout, so xterm and its addons are stubbed at the
 * module boundary and the assertions are about construction/teardown calls, not
 * about pixels or timings.
 */

const xterm = vi.hoisted(() => {
  type FakeTerminal = {
    options: Record<string, unknown>;
    cols: number;
    rows: number;
    openedIn: HTMLElement | null;
    addons: unknown[];
    dispose: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  const terminals: FakeTerminal[] = [];
  const fits: { fit: ReturnType<typeof vi.fn> }[] = [];
  const webgls: { dispose: ReturnType<typeof vi.fn>; loseContext: () => void }[] = [];
  // Construction order, so "the WebGL upgrade happens after the terminal is on
  // screen" can be asserted rather than assumed.
  const events: string[] = [];
  const clipboardArgs: unknown[][] = [];
  // Seam for the "build throws" test — spying on a real xterm method is not an
  // option when the module is stubbed.
  const hooks = { onOpen: () => {} };

  return { terminals, fits, webgls, events, clipboardArgs, hooks };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    openedIn: HTMLElement | null = null;
    element: HTMLElement | null = null;
    addons: unknown[] = [];
    dispose = vi.fn();
    refresh = vi.fn();
    clear = vi.fn();
    write = vi.fn();
    getSelection = vi.fn(() => '');
    hasSelection = vi.fn(() => false);
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));

    constructor(options: Record<string, unknown>) {
      this.options = options;
      xterm.terminals.push(this as never);
      xterm.events.push('terminal');
    }

    loadAddon(addon: unknown) {
      this.addons.push(addon);
    }

    open(container: HTMLElement) {
      xterm.hooks.onOpen();
      this.openedIn = container;
      // The real xterm puts `.xterm` inside the container, and `FitAddon`
      // measures that parent — the sizing guard reads the same chain.
      this.element = { parentElement: container } as unknown as HTMLElement;
      xterm.events.push('open');
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();

    constructor() {
      xterm.fits.push(this as never);
    }
  },
}));

vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {
    constructor(...args: unknown[]) {
      xterm.clipboardArgs.push(args);
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    dispose = vi.fn();
    private handler: (() => void) | null = null;

    constructor() {
      xterm.webgls.push(this as never);
      xterm.events.push('webgl');
    }

    onContextLoss(handler: () => void) {
      this.handler = handler;
    }

    loseContext() {
      this.handler?.();
    }
  },
}));

vi.mock('../utils/mobileTerminalSelection', () => ({
  installMobileTerminalSelection: () => ({ dispose: vi.fn(), updateHandles: vi.fn() }),
}));

const { useShellTerminal } = await import('./useShellTerminal');

const PROJECT = { path: '/tmp/project', fullPath: '/tmp/project', displayName: 'project' } as unknown as Project;

type HarnessProps = {
  isActive?: boolean;
  closeSocket?: () => void;
  project?: Project | null;
  socket?: WebSocket | null;
};

/**
 * jsdom has no layout, so every element measures zero — which is exactly what a
 * `display: none` element reports in a real browser. Tests therefore have to
 * say explicitly whether the container is on screen.
 */
function setContainerSize(element: HTMLElement, width: number, height: number) {
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: height, configurable: true });
}

function fakeSocket() {
  return { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function resizeFrames(socket: { send: ReturnType<typeof vi.fn> }) {
  return socket.send.mock.calls
    .map(([payload]) => JSON.parse(String(payload)))
    .filter((message) => message.type === 'resize');
}

function Harness({ isActive = true, closeSocket, project = PROJECT, socket = null }: HarnessProps) {
  // `useShellRuntime` hands the hook a `useCallback`-stable `closeSocket`; a new
  // identity per render would tear the terminal down and rebuild it, which is
  // exactly what these tests are checking does not happen.
  const closeSocketRef = useRef(closeSocket);
  closeSocketRef.current = closeSocket;
  const stableCloseSocket = useCallback(() => {
    closeSocketRef.current?.();
  }, []);

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null) as MutableRefObject<Terminal | null>;
  const fitAddonRef = useRef<FitAddon | null>(null) as MutableRefObject<FitAddon | null>;
  const wsRef = useRef<WebSocket | null>(socket) as MutableRefObject<WebSocket | null>;
  wsRef.current = socket;

  const { isInitialized } = useShellTerminal({
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    wsRef,
    selectedProject: project,
    minimal: false,
    isRestarting: false,
    isActive,
    closeSocket: stableCloseSocket,
  });

  return (
    <div>
      <span data-testid="chrome">{isInitialized ? 'terminal ready' : 'initializing'}</span>
      <div data-testid="terminal-container" ref={terminalContainerRef} />
    </div>
  );
}

/** Runs the post-paint yield (`requestAnimationFrame` then a task). */
function flushBuild() {
  act(() => {
    vi.advanceTimersByTime(50);
  });
}

/** Runs the idle-scheduled WebGL upgrade that follows the build. */
function flushWebglUpgrade() {
  act(() => {
    vi.advanceTimersByTime(1500);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  xterm.terminals.length = 0;
  xterm.fits.length = 0;
  xterm.webgls.length = 0;
  xterm.events.length = 0;
  xterm.clipboardArgs.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useShellTerminal — deferred construction (#272)', () => {
  it('renders the chrome before xterm is constructed', () => {
    render(<Harness />);

    expect(screen.getByTestId('chrome')).toHaveTextContent('initializing');
    expect(xterm.terminals).toHaveLength(0);

    flushBuild();

    expect(xterm.terminals).toHaveLength(1);
    expect(screen.getByTestId('chrome')).toHaveTextContent('terminal ready');
  });

  it('opens the terminal in the container once the deferred build runs', () => {
    render(<Harness />);
    flushBuild();

    expect(xterm.terminals[0].openedIn).toBe(screen.getByTestId('terminal-container'));
  });

  it('still builds when the document never paints and rAF is never serviced', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);

    render(<Harness />);
    expect(xterm.terminals).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    // A backgrounded tab (the provider-login shell) must still come up.
    expect(xterm.terminals).toHaveLength(1);
    rafSpy.mockRestore();
  });

  it('builds only once when both the post-paint yield and the fallback fire', () => {
    render(<Harness />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(xterm.terminals).toHaveLength(1);
  });

  it('upgrades to the WebGL renderer only after the terminal is on screen', () => {
    render(<Harness />);
    flushBuild();

    // Context creation, shader compilation and the first glyph atlas are the
    // most expensive part of opening a shell, and none of it has to happen
    // before the prompt is visible.
    expect(xterm.events).toEqual(['terminal', 'open']);

    flushWebglUpgrade();

    expect(xterm.events).toEqual(['terminal', 'open', 'webgl']);
  });

  it('does not upgrade a terminal that was disposed before the WebGL task ran', () => {
    const { unmount } = render(<Harness />);

    act(() => {
      vi.advanceTimersToNextTimer();
      vi.advanceTimersToNextTimer();
    });
    expect(xterm.events).toEqual(['terminal', 'open']);

    unmount();
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(xterm.webgls).toHaveLength(0);
  });

  it('passes the OSC 52 provider as the clipboard addon\'s second argument', () => {
    render(<Harness />);
    flushBuild();

    // The addon's published typing says `(provider?)` but the shipped runtime
    // takes `(base64?, provider?)` — a silent swap here would break the
    // device-flow "press c to copy" prompt and nothing else would notice.
    expect(xterm.clipboardArgs).toHaveLength(1);
    const [base64, provider] = xterm.clipboardArgs[0] as [unknown, { writeText?: unknown }];
    expect(base64).toBeUndefined();
    expect(typeof provider?.writeText).toBe('function');
  });

  it('schedules the WebGL upgrade through requestIdleCallback when the browser has one', () => {
    const idleCallbacks: (() => void)[] = [];
    const cancelIdle = vi.fn();
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idleCallbacks.push(callback);
      return 7;
    });
    vi.stubGlobal('cancelIdleCallback', cancelIdle);

    const { unmount } = render(<Harness />);
    flushBuild();

    // Chrome/Firefox take this branch — jsdom has no rIC, so without the stub
    // only the Safari fallback would ever be exercised.
    expect(idleCallbacks).toHaveLength(1);
    expect(xterm.webgls).toHaveLength(0);

    act(() => {
      idleCallbacks[0]();
    });
    expect(xterm.webgls).toHaveLength(1);

    unmount();
    expect(cancelIdle).toHaveBeenCalledWith(7);
    vi.unstubAllGlobals();
  });

  it('never constructs a terminal when the surface goes away before the yield', () => {
    const { unmount } = render(<Harness />);

    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(xterm.terminals).toHaveLength(0);
  });
});

describe('useShellTerminal — mounted-but-hidden surface (#272)', () => {
  it('constructs the terminal exactly once across a hide/show cycle', () => {
    const { rerender } = render(<Harness isActive />);
    flushBuild();
    expect(xterm.terminals).toHaveLength(1);

    rerender(<Harness isActive={false} />);
    flushBuild();
    rerender(<Harness isActive />);
    flushBuild();

    expect(xterm.terminals).toHaveLength(1);
    expect(xterm.terminals[0].dispose).not.toHaveBeenCalled();
  });

  it('re-fits and tells the pty the new size when the grid changed while hidden', () => {
    const socket = fakeSocket();
    const { rerender } = render(<Harness isActive socket={socket} />);
    setContainerSize(screen.getByTestId('terminal-container'), 1120, 768);
    flushBuild();

    const fitAddon = xterm.fits[0];
    const terminal = xterm.terminals[0];
    // The window was resized while the surface was away, so the fit on the way
    // back in lands on a different grid.
    fitAddon.fit.mockImplementation(() => {
      terminal.cols = 107;
      terminal.rows = 40;
    });
    socket.send.mockClear();

    rerender(<Harness isActive={false} socket={socket} />);
    flushBuild();
    rerender(<Harness isActive socket={socket} />);
    flushBuild();

    expect(fitAddon.fit).toHaveBeenCalled();
    expect(resizeFrames(socket)).toContainEqual({ type: 'resize', cols: 107, rows: 40 });
  });

  it('repaints instead of resizing when the grid is unchanged on reveal', () => {
    const socket = fakeSocket();
    const { rerender } = render(<Harness isActive socket={socket} />);
    setContainerSize(screen.getByTestId('terminal-container'), 1120, 768);
    flushBuild();
    // Past the initial fit, which legitimately reports the first size.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    socket.send.mockClear();

    rerender(<Harness isActive={false} socket={socket} />);
    flushBuild();
    rerender(<Harness isActive socket={socket} />);
    flushBuild();

    // A hidden canvas can come back stale, so the reveal always repaints.
    expect(xterm.terminals[0].refresh).toHaveBeenCalled();
    expect(resizeFrames(socket)).toHaveLength(0);
  });

  it('does not fit while the surface stays hidden', () => {
    const { rerender } = render(<Harness isActive={false} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const fitAddon = xterm.fits[0];
    fitAddon.fit.mockClear();

    rerender(<Harness isActive={false} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(fitAddon.fit).not.toHaveBeenCalled();
  });
});

describe('useShellTerminal — resizing a hidden terminal (#272 follow-up)', () => {
  /*
   * The surface now stays mounted, so its `ResizeObserver` keeps firing after
   * the tab is hidden — and a `display: none` container does not measure as
   * "no size" to `FitAddon`: it reads the *computed* `height: 100%` as 100px
   * and resizes the terminal to about 10x6. That resize was forwarded to the
   * pty, i.e. a SIGWINCH telling whatever is running that the window is now ten
   * columns wide. Verified in a real browser before the guard landed.
   */
  function renderWithObserver(socket: ReturnType<typeof fakeSocket>) {
    const callbacks: (() => void)[] = [];
    const previous = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    const view = render(<Harness isActive socket={socket} />);
    const container = screen.getByTestId('terminal-container');
    setContainerSize(container, 1120, 768);
    flushBuild();

    const fireResize = () => {
      act(() => {
        callbacks.forEach((callback) => callback());
        vi.advanceTimersByTime(200);
      });
    };

    return { view, container, fireResize, restore: () => { globalThis.ResizeObserver = previous; } };
  }

  it('never resizes the pty from a container that measures zero', () => {
    const socket = fakeSocket();
    const { container, fireResize, restore } = renderWithObserver(socket);
    const fitAddon = xterm.fits[0];

    socket.send.mockClear();
    fitAddon.fit.mockClear();
    // The tab was switched away: the container is inside a `display: none`
    // subtree now.
    setContainerSize(container, 0, 0);
    fireResize();

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(resizeFrames(socket)).toHaveLength(0);
    restore();
  });

  it('still resizes the pty when the visible container changes size', () => {
    const socket = fakeSocket();
    const { container, fireResize, restore } = renderWithObserver(socket);
    const terminal = xterm.terminals[0];

    socket.send.mockClear();
    xterm.fits[0].fit.mockImplementation(() => {
      terminal.cols = 107;
      terminal.rows = 40;
    });
    setContainerSize(container, 856, 640);
    fireResize();

    expect(resizeFrames(socket)).toContainEqual({ type: 'resize', cols: 107, rows: 40 });
    restore();
  });
});

describe('useShellTerminal — a build that throws (#272 follow-up)', () => {
  class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
      return { failed: true };
    }

    render() {
      return this.state.failed ? <span data-testid="boundary">terminal failed</span> : this.props.children;
    }
  }

  it('surfaces the failure to the error boundary instead of hanging on the loading overlay', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const openSpy = vi
      .spyOn(xterm.hooks, 'onOpen')
      .mockImplementation(() => {
        throw new Error('renderer exploded');
      });

    render(
      <Boundary>
        <Harness />
      </Boundary>,
    );
    flushBuild();

    // Construction happens in a scheduled callback now, and React only sees
    // throws from render/effects — without re-throwing, the surface would sit
    // on "Initializing…" forever with nothing to click.
    expect(screen.getByTestId('boundary')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalled();

    openSpy.mockRestore();
    consoleError.mockRestore();
  });
});

describe('useShellTerminal — teardown (#272)', () => {
  it('disposes the terminal and closes the socket when the surface unmounts', () => {
    const closeSocket = vi.fn();
    const { unmount } = render(<Harness closeSocket={closeSocket} />);
    flushBuild();

    const terminal = xterm.terminals[0];
    unmount();

    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(closeSocket).toHaveBeenCalledTimes(1);
  });

  it('drops the WebGL addon when the context is lost instead of leaving a blank terminal', () => {
    render(<Harness />);
    flushBuild();
    flushWebglUpgrade();

    const webgl = xterm.webgls[0];
    expect(webgl.dispose).not.toHaveBeenCalled();

    webgl.loseContext();

    expect(webgl.dispose).toHaveBeenCalledTimes(1);
  });
});
