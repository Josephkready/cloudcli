import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

/*
 * `installMobileTerminalSelection` wires up long-press word selection, drag
 * handles, pinch-zoom and inertial scrolling directly against DOM touch
 * events — none of it goes through React. jsdom has no `TouchEvent`
 * constructor and no layout, so touches are plain `{clientX, clientY}`
 * objects glued onto generic `Event`s, and every element's
 * `getBoundingClientRect`/cell geometry is stubbed by hand.
 */

const copyTextToClipboard = vi.fn(async (_text: string) => true);
vi.mock('../../../utils/clipboard', () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text),
}));

const { installMobileTerminalSelection } = await import('./mobileTerminalSelection');

const CELL_WIDTH = 10;
const CELL_HEIGHT = 20;

function rect(width: number, height: number, left = 0, top = 0) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

type Listeners = {
  selectionChange: Array<() => void>;
  resize: Array<() => void>;
  scroll: Array<() => void>;
};

function createFakeTerminal(lines: Map<number, string>) {
  const element = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  const viewport = document.createElement('div');
  viewport.className = 'xterm-viewport';
  const textarea = document.createElement('textarea');
  textarea.className = 'xterm-helper-textarea';
  element.append(screen, viewport, textarea);

  screen.getBoundingClientRect = () => rect(800, 400);
  Object.defineProperty(viewport, 'scrollTop', {
    value: 0,
    writable: true,
    configurable: true,
  });
  const blurSpy = vi.fn();
  textarea.blur = blurSpy;

  const listeners: Listeners = { selectionChange: [], resize: [], scroll: [] };

  const terminal = {
    element,
    cols: 80,
    rows: 24,
    options: { fontSize: 14 } as { fontSize?: number },
    buffer: {
      active: {
        viewportY: 0,
        getLine: (row: number) => {
          const text = lines.get(row);
          if (text === undefined) return undefined;
          return { translateToString: () => text };
        },
      },
    },
    onSelectionChange: (cb: () => void) => {
      listeners.selectionChange.push(cb);
      return { dispose: vi.fn() };
    },
    onResize: (cb: () => void) => {
      listeners.resize.push(cb);
      return { dispose: vi.fn() };
    },
    onScroll: (cb: () => void) => {
      listeners.scroll.push(cb);
      return { dispose: vi.fn() };
    },
    hasSelection: vi.fn(() => true),
    select: vi.fn(),
    selectAll: vi.fn(),
    getSelection: vi.fn(() => 'selected text'),
    clearSelection: vi.fn(),
    refresh: vi.fn(),
    _core: { _renderService: { dimensions: { css: { cell: { width: CELL_WIDTH, height: CELL_HEIGHT } } } } },
  } as unknown as Terminal;

  return { terminal, element, screen, viewport, textarea, blurSpy, listeners };
}

function touchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches, configurable: true });
  return event;
}

// jsdom's `Window` ships an `ontouchstart` own property regardless of the
// device, so `'ontouchstart' in window` is always true there — the real
// signal to flip for these tests is `navigator.maxTouchPoints`, but it can
// only gate the check once `ontouchstart` is removed from the window too.
let originalOnTouchStart: PropertyDescriptor | undefined;

function enableTouchEnvironment() {
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
  if (originalOnTouchStart) {
    Object.defineProperty(window, 'ontouchstart', originalOnTouchStart);
  }
}

function disableTouchEnvironment() {
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
  if (!originalOnTouchStart) {
    originalOnTouchStart = Object.getOwnPropertyDescriptor(window, 'ontouchstart');
  }
  delete (window as { ontouchstart?: unknown }).ontouchstart;
}

let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  enableTouchEnvironment();
  container = document.createElement('div');
  document.body.appendChild(container);
  copyTextToClipboard.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  disableTouchEnvironment();
  container.remove();
});

describe('installMobileTerminalSelection — environment gating', () => {
  it('returns null outside a touch environment', () => {
    disableTouchEnvironment();
    const { terminal, element } = createFakeTerminal(new Map());
    container.appendChild(element);

    expect(installMobileTerminalSelection(terminal, container)).toBeNull();
  });

  it('returns null when the terminal has no element yet', () => {
    const { terminal } = createFakeTerminal(new Map());
    (terminal as unknown as { element: null }).element = null;

    expect(installMobileTerminalSelection(terminal, container)).toBeNull();
  });

  it('mounts an overlay with hidden handles and a hidden context menu', () => {
    const { terminal, element } = createFakeTerminal(new Map());
    container.appendChild(element);

    const manager = installMobileTerminalSelection(terminal, container);
    expect(manager).not.toBeNull();

    expect(container.style.position).toBe('relative');
    const overlay = container.querySelector('.shell-mobile-selection-overlay');
    expect(overlay).not.toBeNull();
    const startHandle = container.querySelector('.shell-mobile-selection-handle-start') as HTMLElement;
    const endHandle = container.querySelector('.shell-mobile-selection-handle-end') as HTMLElement;
    expect(startHandle.style.display).toBe('none');
    expect(endHandle.style.display).toBe('none');
    const menu = container.querySelector('.shell-mobile-selection-menu') as HTMLElement;
    expect(menu.style.display).toBe('none');

    manager?.dispose();
  });

  it('restores the original inline position on dispose', () => {
    container.style.position = 'static';
    const { terminal, element } = createFakeTerminal(new Map());
    container.appendChild(element);

    const manager = installMobileTerminalSelection(terminal, container);
    expect(container.style.position).toBe('relative');

    manager?.dispose();
    expect(container.style.position).toBe('static');
    expect(container.querySelector('.shell-mobile-selection-overlay')).toBeNull();
  });
});

describe('installMobileTerminalSelection — long-press word selection', () => {
  it('selects the word under a long press', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    // col = floor(25/10) = 2 -> inside "hello" (indices 0-4)
    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);

    expect(terminal.select).toHaveBeenCalledWith(0, 0, 5);
    const startHandle = container.querySelector('.shell-mobile-selection-handle-start') as HTMLElement;
    expect(startHandle.style.display).toBe('block');
    const menu = container.querySelector('.shell-mobile-selection-menu') as HTMLElement;
    expect(menu.style.display).toBe('flex');

    manager.dispose();
  });

  it('selects a single cell when long-pressing whitespace', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    // col = floor(55/10) = 5 -> the space between "hello" and "world"
    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 55, clientY: 10 }]));
    vi.advanceTimersByTime(600);

    expect(terminal.select).toHaveBeenCalledWith(5, 0, 1);
    manager.dispose();
  });

  it('does not select on a quick tap released before the long-press fires', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    element.dispatchEvent(touchEvent('touchend', []));
    vi.advanceTimersByTime(600);

    expect(terminal.select).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('cancels the pending long press once the finger moves past the threshold', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    element.dispatchEvent(touchEvent('touchmove', [{ clientX: 60, clientY: 10 }]));
    vi.advanceTimersByTime(600);

    expect(terminal.select).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('extends an active selection as the finger drags, spanning multiple rows', () => {
    const lines = new Map([
      [0, 'hello world'],
      [1, 'second line'],
    ]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);
    (terminal.select as ReturnType<typeof vi.fn>).mockClear();

    // Drag down onto row 1 (y = 25 -> row floor(25/20) = 1), col 3.
    element.dispatchEvent(touchEvent('touchmove', [{ clientX: 35, clientY: 25 }]));

    expect(terminal.select).toHaveBeenCalled();
    const [col, row, length] = (terminal.select as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(row).toBe(0);
    expect(col).toBe(0);
    expect(length).toBe((1 - 0) * terminal.cols - 0 + 3 + 1);

    manager.dispose();
  });

  it('clears the selection on a plain tap that lands without moving', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);
    expect(terminal.select).toHaveBeenCalled();

    // A fresh finger-down while selecting is a "tap to dismiss" gesture.
    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    element.dispatchEvent(touchEvent('touchend', []));

    expect(terminal.clearSelection).toHaveBeenCalled();
    manager.dispose();
  });

  it('blurs the hidden textarea so a long-press selection does not reopen the keyboard', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element, blurSpy } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);

    expect(blurSpy).toHaveBeenCalled();
    manager.dispose();
  });
});

describe('installMobileTerminalSelection — drag handles', () => {
  function startSelection(element: HTMLElement, terminal: Terminal) {
    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);
    (terminal.select as ReturnType<typeof vi.fn>).mockClear();
  }

  it('moves the end handle and keeps ordering when dragged past the start', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;
    startSelection(element, terminal);

    const endHandle = container.querySelector('.shell-mobile-selection-handle-end') as HTMLElement;
    endHandle.dispatchEvent(touchEvent('touchstart', [{ clientX: 45, clientY: 10 }]));
    endHandle.dispatchEvent(touchEvent('touchmove', [{ clientX: 95, clientY: 10 + 40 }]));
    endHandle.dispatchEvent(touchEvent('touchend', []));

    expect(terminal.select).toHaveBeenCalled();
    const [, , length] = (terminal.select as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(length).toBeGreaterThan(0);

    manager.dispose();
  });

  it('swaps handle roles when the start handle is dragged past the end', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;
    startSelection(element, terminal);

    const startHandle = container.querySelector('.shell-mobile-selection-handle-start') as HTMLElement;
    // Drag the start handle far to the right of the current end (col 4).
    startHandle.dispatchEvent(touchEvent('touchstart', [{ clientX: 5, clientY: 10 }]));
    startHandle.dispatchEvent(touchEvent('touchmove', [{ clientX: 95, clientY: 10 + 40 }]));

    const [col, row] = (terminal.select as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    // The original end of the word ("hello", col 4) becomes the new ordered
    // start once the dragged start handle passes it.
    expect(row).toBe(0);
    expect(col).toBe(4);

    startHandle.dispatchEvent(touchEvent('touchend', []));
    manager.dispose();
  });
});

describe('installMobileTerminalSelection — context menu actions', () => {
  it('copies the current selection and clears it', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);

    const copyButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Copy',
    )!;
    copyButton.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    copyButton.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));

    expect(copyTextToClipboard).toHaveBeenCalledWith('selected text');
    expect(terminal.clearSelection).toHaveBeenCalled();

    manager.dispose();
  });

  it('selects the whole buffer via Select All', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);

    const selectAllButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Select All',
    )!;
    selectAllButton.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    selectAllButton.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));

    expect(terminal.selectAll).toHaveBeenCalled();
    const menu = container.querySelector('.shell-mobile-selection-menu') as HTMLElement;
    expect(menu.style.display).toBe('flex');

    manager.dispose();
  });

  it('clears selection when Select All finds nothing selected', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    (terminal.hasSelection as ReturnType<typeof vi.fn>).mockReturnValue(false);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);
    (terminal.clearSelection as ReturnType<typeof vi.fn>).mockClear();

    const selectAllButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Select All',
    )!;
    selectAllButton.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    selectAllButton.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));

    expect(terminal.clearSelection).toHaveBeenCalled();
    manager.dispose();
  });
});

describe('installMobileTerminalSelection — pinch zoom', () => {
  it('changes the font size proportionally to the pinch distance', () => {
    const { terminal, element } = createFakeTerminal(new Map());
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(
      touchEvent('touchstart', [
        { clientX: 0, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ]),
    );
    element.dispatchEvent(
      touchEvent('touchmove', [
        { clientX: 0, clientY: 0 },
        { clientX: 200, clientY: 0 },
      ]),
    );

    expect(terminal.options.fontSize).toBe(28);
    expect(terminal.refresh).toHaveBeenCalled();

    element.dispatchEvent(touchEvent('touchend', []));
    manager.dispose();
  });

  it('clamps zoom to the configured minimum and maximum font size', () => {
    const { terminal, element } = createFakeTerminal(new Map());
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container, {
      minFontSize: 10,
      maxFontSize: 16,
    })!;

    element.dispatchEvent(
      touchEvent('touchstart', [
        { clientX: 0, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ]),
    );
    element.dispatchEvent(
      touchEvent('touchmove', [
        { clientX: 0, clientY: 0 },
        { clientX: 1000, clientY: 0 },
      ]),
    );

    expect(terminal.options.fontSize).toBe(16);

    element.dispatchEvent(touchEvent('touchend', []));
    manager.dispose();
  });

  it('uses a custom onFontSizeChange callback instead of mutating the terminal directly', () => {
    const { terminal, element } = createFakeTerminal(new Map());
    container.appendChild(element);
    const onFontSizeChange = vi.fn();
    const manager = installMobileTerminalSelection(terminal, container, { onFontSizeChange })!;

    element.dispatchEvent(
      touchEvent('touchstart', [
        { clientX: 0, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ]),
    );
    element.dispatchEvent(
      touchEvent('touchmove', [
        { clientX: 0, clientY: 0 },
        { clientX: 200, clientY: 0 },
      ]),
    );

    expect(onFontSizeChange).toHaveBeenCalledWith(28);
    expect(terminal.options.fontSize).toBe(14);

    element.dispatchEvent(touchEvent('touchend', []));
    manager.dispose();
  });
});

describe('installMobileTerminalSelection — document tap dismissal', () => {
  it('clears the selection when a touch lands outside the terminal container', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);
    expect(terminal.select).toHaveBeenCalled();

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(touchEvent('touchstart', [{ clientX: 999, clientY: 999 }]));

    expect(terminal.clearSelection).toHaveBeenCalled();
    outside.remove();
    manager.dispose();
  });
});

describe('installMobileTerminalSelection — inertial scrolling', () => {
  it('coasts the viewport after a fast one-finger flick and stops decaying', () => {
    const { terminal, element, viewport } = createFakeTerminal(new Map());
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 300 }]));
    // Two fast samples moving upward (finger moves down the screen -> content
    // scrolls up), each tick advancing the clock so velocity is computed.
    vi.advanceTimersByTime(8);
    element.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 250 }]));
    vi.advanceTimersByTime(8);
    element.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 200 }]));
    element.dispatchEvent(touchEvent('touchend', []));

    const before = viewport.scrollTop;
    vi.advanceTimersByTime(500);

    expect(viewport.scrollTop).not.toBe(before);
    manager.dispose();
  });

  it('does not start inertia after an idle pause before release', () => {
    const { terminal, element, viewport } = createFakeTerminal(new Map());
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 300 }]));
    vi.advanceTimersByTime(8);
    element.dispatchEvent(touchEvent('touchmove', [{ clientX: 10, clientY: 200 }]));
    // Finger pauses well past the idle window before lifting.
    vi.advanceTimersByTime(500);
    element.dispatchEvent(touchEvent('touchend', []));

    const before = viewport.scrollTop;
    vi.advanceTimersByTime(300);

    expect(viewport.scrollTop).toBe(before);
    manager.dispose();
  });
});

describe('installMobileTerminalSelection — xterm event wiring and teardown', () => {
  it('repositions handles on terminal resize and scroll', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element, listeners } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);

    const startHandle = container.querySelector('.shell-mobile-selection-handle-start') as HTMLElement;
    startHandle.style.left = '';

    listeners.resize.forEach((cb) => cb());
    expect(startHandle.style.left).not.toBe('');

    listeners.scroll.forEach((cb) => cb());
    manager.dispose();
  });

  it('clears its own state when xterm reports the selection is gone', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element, listeners } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);

    (terminal.hasSelection as ReturnType<typeof vi.fn>).mockReturnValue(false);
    listeners.selectionChange.forEach((cb) => cb());

    const startHandle = container.querySelector('.shell-mobile-selection-handle-start') as HTMLElement;
    expect(startHandle.style.display).toBe('none');

    manager.dispose();
  });

  it('stops reacting to touches once disposed', () => {
    const lines = new Map([[0, 'hello world']]);
    const { terminal, element } = createFakeTerminal(lines);
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;
    manager.dispose();

    element.dispatchEvent(touchEvent('touchstart', [{ clientX: 25, clientY: 10 }]));
    vi.advanceTimersByTime(600);

    expect(terminal.select).not.toHaveBeenCalled();
  });

  it('is safe to dispose twice', () => {
    const { terminal, element } = createFakeTerminal(new Map());
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
  });

  it('cancels a two-finger touch cleanly when it becomes a cancel event', () => {
    const { terminal, element } = createFakeTerminal(new Map());
    container.appendChild(element);
    const manager = installMobileTerminalSelection(terminal, container)!;

    element.dispatchEvent(
      touchEvent('touchstart', [
        { clientX: 0, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ]),
    );
    element.dispatchEvent(touchEvent('touchcancel', []));

    expect(() => manager.dispose()).not.toThrow();
  });
});
