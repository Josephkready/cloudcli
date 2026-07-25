import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';
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

  return { terminals, fits, webgls, events };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    openedIn: HTMLElement | null = null;
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
      this.openedIn = container;
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

vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
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
};

function Harness({ isActive = true, closeSocket, project = PROJECT }: HarnessProps) {
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
  const wsRef = useRef<WebSocket | null>(null) as MutableRefObject<WebSocket | null>;

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

  it('re-fits on the way back in, because a hidden container measures as zero', () => {
    const { rerender } = render(<Harness isActive />);
    flushBuild();

    const fitAddon = xterm.fits[0];
    const fitsAfterMount = fitAddon.fit.mock.calls.length;

    rerender(<Harness isActive={false} />);
    flushBuild();
    rerender(<Harness isActive />);
    flushBuild();

    expect(fitAddon.fit.mock.calls.length).toBeGreaterThan(fitsAfterMount);
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

    // Fitting a `display: none` container measures zero and would resize the
    // pty to nonsense.
    expect(fitAddon.fit).not.toHaveBeenCalled();
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
