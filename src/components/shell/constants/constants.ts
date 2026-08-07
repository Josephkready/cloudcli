import type { ITerminalOptions } from '@xterm/xterm';

export const SHELL_RESTART_DELAY_MS = 200;
export const TERMINAL_INIT_DELAY_MS = 100;
export const TERMINAL_RESIZE_DELAY_MS = 50;

/**
 * Backstop for building the terminal when no paint ever happens (#272).
 *
 * The build is normally scheduled off the frame that paints the shell chrome,
 * but a hidden document never paints and therefore never runs its rAF callback
 * — the provider-login terminal has to come up in a background tab all the
 * same. This timer is what gets it built there. It is not a paint-tuning knob:
 * in the visible case the rAF path wins the race long before it fires.
 */
export const TERMINAL_BUILD_FALLBACK_DELAY_MS = 120;

/**
 * Upper bound on how long the terminal runs on xterm's DOM renderer before the
 * WebGL upgrade is forced through, and the delay used where there is no
 * `requestIdleCallback` (Safari). Long enough for the pty handshake and first
 * prompt to land first, short enough that heavy output is on the fast renderer.
 */
export const WEBGL_UPGRADE_IDLE_TIMEOUT_MS = 1_000;
export const WEBGL_UPGRADE_FALLBACK_DELAY_MS = 300;

// CLI prompt overlay detection
export const PROMPT_DEBOUNCE_MS = 500;
export const PROMPT_BUFFER_SCAN_LINES = 20;
export const PROMPT_OPTION_SCAN_LINES = 15;
export const PROMPT_MAX_OPTIONS = 5;
export const PROMPT_MIN_OPTIONS = 2;

/**
 * Single source of truth for the terminal surface colour (#246).
 *
 * xterm quantises its canvas height to whole rows, so the wrapper's leftover
 * space (plus the container padding) is always visible around the terminal.
 * When the wrapper used Tailwind `bg-gray-900` (#111827) and xterm painted
 * `#1e1e1e`, that leftover showed up as a band of the wrong grey — a mismatch
 * no amount of sizing can hide. Both the xterm theme and the React wrappers
 * read this constant so they can't drift apart again.
 */
export const TERMINAL_BACKGROUND_COLOR = '#1e1e1e';

/** Inline style for any element framing the xterm canvas. */
export const TERMINAL_SURFACE_STYLE = { backgroundColor: TERMINAL_BACKGROUND_COLOR } as const;

export const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  allowProposedApi: true,
  allowTransparency: false,
  convertEol: true,
  scrollback: 10000,
  tabStopWidth: 4,
  windowsMode: false,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  // Keep the runtime theme keys used by the previous JSX implementation.
  theme: {
    background: TERMINAL_BACKGROUND_COLOR,
    foreground: '#d4d4d4',
    cursor: '#ffffff',
    cursorAccent: TERMINAL_BACKGROUND_COLOR,
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff',
    extendedAnsi: [
      '#000000',
      '#800000',
      '#008000',
      '#808000',
      '#000080',
      '#800080',
      '#008080',
      '#c0c0c0',
      '#808080',
      '#ff0000',
      '#00ff00',
      '#ffff00',
      '#0000ff',
      '#ff00ff',
      '#00ffff',
      '#ffffff',
    ],
  },
};
