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
  const restore = installFakeWindow({ innerWidth: 390, innerHeight: 797, visualHeight: 461 });
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
  const restore = installFakeWindow({ innerWidth: 390, innerHeight: 797, visualHeight: 797 });
  try {
    assert.equal(readBrowserEnvironment().keyboardInset, '0px');
  } finally {
    restore();
  }
});

/** Minimal `window` stand-in; returns a teardown that restores the global. */
function installFakeWindow(input: {
  innerWidth: number;
  innerHeight: number;
  visualHeight: number;
}): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.window;
  globals.window = {
    innerWidth: input.innerWidth,
    innerHeight: input.innerHeight,
    visualViewport: { width: input.innerWidth, height: input.visualHeight, offsetTop: 0 },
    navigator: { userAgent: 'test', language: 'en-US' },
    location: { pathname: '/', search: '' },
  };
  return () => {
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  };
}
