import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBugReportMetadata, readBrowserEnvironment } from './buildBugReportMetadata';

/**
 * The keyboard fields a report has to carry, and why.
 *
 * #354 and #357 were both filed from an iPhone with the keyboard covering the
 * input, and both reports said `Viewport: 390×797`. That number is
 * `innerWidth×innerHeight` — the **layout** viewport, the one iOS deliberately
 * leaves alone while the keyboard is up. So the single field that could have
 * distinguished "the app never noticed the keyboard" from "the app noticed and
 * the surface ignored it" was identical in the working and broken cases, and the
 * reports could not settle it.
 *
 * Both bugs live in the gap between the layout viewport, the visual viewport and
 * what the app published, so a report has to carry all three or it cannot
 * discriminate. This is instrumentation, not a fix — but it is the difference
 * between diagnosing the next one from the issue and guessing again.
 */

const BASE = {
  appVersion: '1.36.3',
  activeTab: 'chat' as const,
  project: null,
  session: null,
};

test('a report carries the visual viewport alongside the layout viewport', () => {
  const metadata = buildBugReportMetadata({
    ...BASE,
    environment: {
      viewport: '390×797',
      visualViewport: '390×461',
      keyboardInset: '336px',
    },
  });

  assert.equal(metadata.viewport, '390×797');
  assert.equal(metadata.visualViewport, '390×461');
  assert.equal(metadata.keyboardInset, '336px');
});

test('the keyboard fields are omitted when the browser has no Visual Viewport API', () => {
  // Desktop Firefox and older engines have no `visualViewport`. The row should
  // vanish rather than render as "undefined", matching every other optional key.
  const metadata = buildBugReportMetadata({
    ...BASE,
    environment: { viewport: '1440×900' },
  });

  assert.equal(metadata.viewport, '1440×900');
  assert.ok(!('visualViewport' in metadata));
  assert.ok(!('keyboardInset' in metadata));
});

test('readBrowserEnvironment reports a keyboard-covered viewport distinctly', () => {
  // The exact iOS signature: layout viewport unchanged, visual viewport short by
  // the keyboard. Asserted through the real reader so the two values cannot be
  // wired to the same source — which is the bug this test exists to prevent.
  const restore = installFakeWindow({
    innerWidth: 390,
    innerHeight: 797,
    visualHeight: 461,
    published: '336px',
  });
  try {
    const environment = readBrowserEnvironment();
    assert.equal(environment.viewport, '390×797');
    assert.equal(environment.visualViewport, '390×461');
    assert.equal(environment.keyboardInset, '336px');
  } finally {
    restore();
  }
});

test('readBrowserEnvironment reports no keyboard when the two viewports agree', () => {
  const restore = installFakeWindow({
    innerWidth: 390,
    innerHeight: 797,
    visualHeight: 797,
    published: '0px',
  });
  try {
    assert.equal(readBrowserEnvironment().keyboardInset, '0px');
  } finally {
    restore();
  }
});

/*
 * The three rows only diagnose anything if they come from three sources.
 *
 * `keyboardInset` is documented as what the app *believes* is covered, and the
 * table on #354 leans on that: "visible short, inset 0" is supposed to mean the
 * app was told and failed to publish. Computing the inset as
 * `innerHeight - visualViewport.height` makes that row arithmetically
 * unreachable — a short visible viewport forces a non-zero inset — so two of the
 * three rows become the same measurement and the middle case can never be seen.
 *
 * The published `--keyboard-height` is the only independent source, so that is
 * what this field must read.
 */
test('readBrowserEnvironment reports what the app published, not a difference it recomputed', () => {
  const restore = installFakeWindow({
    innerWidth: 390,
    innerHeight: 797,
    visualHeight: 461,
    published: '0px',
  });
  try {
    const environment = readBrowserEnvironment();
    // Told (the visible viewport is 336px short) and yet publishing zero. This
    // is the diagnosis a recomputed inset can never express.
    assert.equal(environment.visualViewport, '390×461');
    assert.equal(environment.keyboardInset, '0px');
  } finally {
    restore();
  }
});

test('a keyboard height that was never published is distinguishable from zero', () => {
  // `installKeyboardViewportSync` sets the variable on resize and on focus, and
  // on nothing else. So "never set" means the publisher has not run at all —
  // a different fault from "ran and produced 0", and worth telling apart.
  const restore = installFakeWindow({
    innerWidth: 390,
    innerHeight: 797,
    visualHeight: 797,
    published: '',
  });
  try {
    assert.equal(readBrowserEnvironment().keyboardInset, 'unset');
  } finally {
    restore();
  }
});

test('a report still gets filed when the keyboard height cannot be read at all', () => {
  // The reporter is what you reach for when the app is already misbehaving, and
  // it is now read during the press that opens it. An engine that refuses
  // `getComputedStyle` must cost this one row, not the whole report.
  const restore = installFakeWindow({
    innerWidth: 390,
    innerHeight: 797,
    visualHeight: 461,
    published: '336px',
    computedStyleThrows: true,
  });
  try {
    const environment = readBrowserEnvironment();
    assert.equal(environment.keyboardInset, undefined);
    assert.equal(environment.viewport, '390×797');
    assert.equal(environment.visualViewport, '390×461');
  } finally {
    restore();
  }
});

/** Minimal `window` stand-in; returns a teardown that restores the global. */
function installFakeWindow(input: {
  innerWidth: number;
  innerHeight: number;
  visualHeight: number;
  /** Value of `--keyboard-height`, as the app would have published it. */
  published: string;
  /** Stands in for an engine that refuses the call outright. */
  computedStyleThrows?: boolean;
}): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.window;
  const documentElement = {};
  globals.window = {
    innerWidth: input.innerWidth,
    innerHeight: input.innerHeight,
    visualViewport: { width: input.innerWidth, height: input.visualHeight, offsetTop: 0 },
    navigator: { userAgent: 'test', language: 'en-US' },
    location: { pathname: '/', search: '' },
    document: { documentElement },
    getComputedStyle: (element: unknown) => {
      if (input.computedStyleThrows) throw new Error('getComputedStyle is unavailable');
      return {
        getPropertyValue: (property: string) =>
          element === documentElement && property === '--keyboard-height' ? input.published : '',
      };
    },
  };
  return () => {
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  };
}
