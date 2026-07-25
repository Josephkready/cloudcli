import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fitTerminalIfMeasurable, isMeasurable } from './terminalSizing';

type FakeTerminal = {
  cols: number;
  rows: number;
  element: { parentElement: { clientWidth: number; clientHeight: number } | null } | null;
};

function fakeTerminal(overrides: Partial<FakeTerminal> = {}) {
  return {
    cols: 140,
    rows: 48,
    element: { parentElement: { clientWidth: 1120, clientHeight: 768 } },
    ...overrides,
  } as FakeTerminal;
}

function fakeFitAddon(terminal: FakeTerminal, next?: { cols: number; rows: number }) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fit() {
      calls += 1;
      if (next) {
        terminal.cols = next.cols;
        terminal.rows = next.rows;
      }
    },
  };
}

describe('terminalSizing (#272 follow-up)', () => {
  it('treats a zero-sized element as unmeasurable', () => {
    // What a `display: none` subtree reports — and the reason the guard exists.
    assert.equal(isMeasurable({ clientWidth: 0, clientHeight: 0 }), false);
    assert.equal(isMeasurable({ clientWidth: 1120, clientHeight: 0 }), false);
    assert.equal(isMeasurable({ clientWidth: 0, clientHeight: 768 }), false);
    assert.equal(isMeasurable(null), false);
    assert.equal(isMeasurable(undefined), false);
    assert.equal(isMeasurable({ clientWidth: 1120, clientHeight: 768 }), true);
  });

  it('does not fit a hidden terminal', () => {
    const terminal = fakeTerminal({ element: { parentElement: { clientWidth: 0, clientHeight: 0 } } });
    const fitAddon = fakeFitAddon(terminal, { cols: 10, rows: 6 });

    const result = fitTerminalIfMeasurable(terminal as never, fitAddon);

    // Fitting here is what sent `{cols: 10, rows: 6}` to the pty on tab-away.
    assert.deepEqual(result, { fitted: false, changed: false });
    assert.equal(fitAddon.calls, 0);
    assert.equal(terminal.cols, 140);
    assert.equal(terminal.rows, 48);
  });

  it('fits a visible terminal and reports whether the grid changed', () => {
    const terminal = fakeTerminal();
    const fitAddon = fakeFitAddon(terminal, { cols: 107, rows: 40 });

    assert.deepEqual(fitTerminalIfMeasurable(terminal as never, fitAddon), {
      fitted: true,
      changed: true,
    });
    assert.equal(fitAddon.calls, 1);

    const unchanged = fakeTerminal();
    assert.deepEqual(fitTerminalIfMeasurable(unchanged as never, fakeFitAddon(unchanged)), {
      fitted: true,
      changed: false,
    });
  });

  it('prefers an explicitly passed container over the terminal element', () => {
    const terminal = fakeTerminal();
    const fitAddon = fakeFitAddon(terminal);

    const result = fitTerminalIfMeasurable(terminal as never, fitAddon, {
      clientWidth: 0,
      clientHeight: 0,
    });

    assert.equal(result.fitted, false);
    assert.equal(fitAddon.calls, 0);
  });

  it('is a no-op without a terminal or fit addon', () => {
    const terminal = fakeTerminal();

    assert.deepEqual(fitTerminalIfMeasurable(null, fakeFitAddon(terminal)), {
      fitted: false,
      changed: false,
    });
    assert.deepEqual(fitTerminalIfMeasurable(terminal as never, null), {
      fitted: false,
      changed: false,
    });
  });

  it('does not fit a terminal that was never opened', () => {
    const terminal = fakeTerminal({ element: null });
    const fitAddon = fakeFitAddon(terminal);

    assert.equal(fitTerminalIfMeasurable(terminal as never, fitAddon).fitted, false);
    assert.equal(fitAddon.calls, 0);
  });
});
