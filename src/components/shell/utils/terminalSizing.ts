/**
 * Guard around `FitAddon.fit()` for a terminal that may be off screen.
 *
 * Since #272 the shell surface stays mounted and is hidden with `display: none`
 * when another tab is showing, and a hidden container is not a safe thing to
 * measure. `FitAddon` reads `getComputedStyle(parent)`, which for an element
 * inside a `display: none` subtree returns the *computed* value rather than the
 * used one — so the app's `h-full w-full` container reports `100%`, `fit()`
 * happily parses that as 100 pixels, and the terminal is resized to something
 * like 10x6. That is not a cosmetic problem: the resize is forwarded to the pty,
 * so a full-screen program on the other end gets a SIGWINCH telling it the
 * window is now ten columns wide.
 *
 * Measured elements always have a zero client box while hidden, so that is the
 * check: no measurement, no fit, and the terminal keeps the size it had.
 */
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

type MeasurableElement = Pick<HTMLElement, 'clientWidth' | 'clientHeight'>;

export function isMeasurable(element: MeasurableElement | null | undefined): boolean {
  return Boolean(element && element.clientWidth > 0 && element.clientHeight > 0);
}

/**
 * Fits the terminal to `container` (defaulting to whatever xterm was opened
 * into) and reports whether the grid actually changed, so callers only tell the
 * pty about a resize that happened.
 */
export function fitTerminalIfMeasurable(
  terminal: Pick<Terminal, 'cols' | 'rows' | 'element'> | null | undefined,
  fitAddon: Pick<FitAddon, 'fit'> | null | undefined,
  container?: MeasurableElement | null,
): { fitted: boolean; changed: boolean } {
  if (!terminal || !fitAddon) {
    return { fitted: false, changed: false };
  }

  const measured = container ?? terminal.element?.parentElement ?? null;
  if (!isMeasurable(measured)) {
    return { fitted: false, changed: false };
  }

  const previousCols = terminal.cols;
  const previousRows = terminal.rows;
  fitAddon.fit();

  return {
    fitted: true,
    changed: terminal.cols !== previousCols || terminal.rows !== previousRows,
  };
}
