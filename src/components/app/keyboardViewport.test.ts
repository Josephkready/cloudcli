import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeKeyboardHeight,
  installKeyboardViewportSync,
  isTextEntryElement,
  isViewportDisplaced,
  keyboardAwareBottomStyle,
  reviseRestingViewportGap,
  viewportShellStyle,
  type DocumentLike,
  type WindowLike,
} from './keyboardViewport';

/*
 * #334: "sometimes when I go to type in the message box, it scrolls so far down
 * the entire screen is white and I have to exit the keyboard for the message
 * box to come back."
 *
 * On iOS the shell is `position: fixed; inset: 0` with its bottom edge raised by
 * `--keyboard-height`. WebKit *also* scrolls a focused field into view, and it
 * decides to do so against the pre-adjustment layout — where the composer is
 * behind the keyboard. Once the adjustment lands, that displacement is pure
 * surplus: the shell is both shortened and pushed up, off the visible area, and
 * the page renders blank until the keyboard is dismissed.
 *
 * Intermittent because it depends on which ran first, hence the fake viewport
 * below driving both orderings.
 */

interface Harness {
  win: WindowLike;
  doc: DocumentLike;
  fireResize: () => void;
  fireViewportScroll: () => void;
  fireFocusIn: () => void;
  runFrames: (count?: number) => void;
  pendingFrameCount: () => number;
  properties: Record<string, string>;
  scrollCalls: Array<[number, number]>;
}

/**
 * `viewportHeight` defaults to `innerHeight` — the two agree at rest on every
 * platform except the one this file exists for. Pass it to model a standalone
 * iOS PWA, where they disagree by a constant with no keyboard anywhere near.
 */
function makeHarness(options: { innerHeight?: number; viewportHeight?: number } = {}): Harness {
  const listeners: Record<string, Array<() => void>> = {};
  const frames: Array<(timestamp: number) => void> = [];
  let frameTimestamp = 0;
  const properties: Record<string, string> = {};
  const scrollCalls: Array<[number, number]> = [];

  const viewport = {
    height: options.viewportHeight ?? options.innerHeight ?? 800,
    offsetTop: 0,
    addEventListener: (type: string, listener: () => void) => {
      (listeners[type] ||= []).push(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== listener);
    },
  };

  const win: WindowLike = {
    innerHeight: options.innerHeight ?? 800,
    scrollY: 0,
    visualViewport: viewport,
    scrollTo: (x: number, y: number) => {
      scrollCalls.push([x, y]);
      // The real thing moves both of these; the fake must too, or a second pin
      // would look necessary when it is not.
      win.scrollY = y;
      viewport.offsetTop = y;
    },
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      frames.push(callback);
      return frames.length;
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      (listeners[type] ||= []).push(listener as () => void);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== listener);
    },
  };

  const doc: DocumentLike = {
    activeElement: null,
    documentElement: {
      style: {
        setProperty: (property: string, value: string) => {
          properties[property] = value;
        },
      },
    },
  };

  const fire = (type: string) => {
    for (const listener of [...(listeners[type] ?? [])]) listener();
  };

  return {
    win,
    doc,
    fireResize: () => fire('resize'),
    fireViewportScroll: () => fire('scroll'),
    fireFocusIn: () => fire('focusin'),
    runFrames: (count = 1) => {
      for (let frame = 0; frame < count && frames.length > 0; frame += 1) {
        const queued = frames.splice(0, frames.length);
        frameTimestamp += 16;
        for (const callback of queued) callback(frameTimestamp);
      }
    },
    pendingFrameCount: () => frames.length,
    properties,
    scrollCalls,
  };
}

/** The keyboard opens: the visual viewport shrinks and WebKit displaces it. */
function openKeyboard(harness: Harness, keyboardHeight: number, displacement: number) {
  const viewport = harness.win.visualViewport!;
  viewport.height = harness.win.innerHeight - keyboardHeight;
  harness.doc.activeElement = { tagName: 'TEXTAREA' };
  harness.win.scrollY = displacement;
  viewport.offsetTop = displacement;
}

test('computeKeyboardHeight clamps a viewport that reports taller than the window', () => {
  assert.equal(computeKeyboardHeight(800, 500), 300);
  assert.equal(computeKeyboardHeight(800, 800), 0);
  assert.equal(computeKeyboardHeight(800, 812), 0);
});

test('computeKeyboardHeight reports only what exceeds the resting gap', () => {
  // 34px of the 334px difference is the standing disagreement, not keyboard.
  assert.equal(computeKeyboardHeight(852, 518, 34), 300);
  assert.equal(computeKeyboardHeight(852, 818, 34), 0);
  // A gap larger than the difference cannot push the height negative.
  assert.equal(computeKeyboardHeight(852, 818, 50), 0);
});

test('reviseRestingViewportGap calibrates from a sample with nothing focused', () => {
  assert.equal(
    reviseRestingViewportGap(null, {
      innerHeight: 852,
      viewportHeight: 818,
      textEntryFocused: false,
    }),
    34,
  );
});

test('reviseRestingViewportGap ignores every sample taken with a field focused', () => {
  // With the keyboard up the difference *is* the keyboard. Adopting it would
  // make the keyboard measure zero, which is the bug this calibration exists to
  // remove rather than to reintroduce.
  assert.equal(
    reviseRestingViewportGap(34, { innerHeight: 852, viewportHeight: 518, textEntryFocused: true }),
    34,
  );
  assert.equal(
    reviseRestingViewportGap(null, {
      innerHeight: 852,
      viewportHeight: 518,
      textEntryFocused: true,
    }),
    null,
  );
});

test('reviseRestingViewportGap only ever shrinks', () => {
  // Down: a later, smaller resting sample is the more trustworthy one.
  assert.equal(
    reviseRestingViewportGap(34, { innerHeight: 852, viewportHeight: 832, textEntryFocused: false }),
    20,
  );
  // Up: focus leaves a field before iOS finishes retracting, so an unfocused
  // sample can still be looking at a keyboard. It must not inflate the baseline.
  assert.equal(
    reviseRestingViewportGap(34, { innerHeight: 852, viewportHeight: 518, textEntryFocused: false }),
    34,
  );
});

test('reviseRestingViewportGap discards a negative difference rather than flooring it', () => {
  // The visual viewport is never genuinely taller than the layout viewport, so
  // this reading is proof of a mid-transition sample and says nothing about the
  // resting state. Flooring it to 0 would promote the least trustworthy sample
  // there is into the most confident claim the baseline can hold.
  assert.equal(
    reviseRestingViewportGap(null, {
      innerHeight: 800,
      viewportHeight: 812,
      textEntryFocused: false,
    }),
    null,
  );
  assert.equal(
    reviseRestingViewportGap(34, {
      innerHeight: 800,
      viewportHeight: 812,
      textEntryFocused: false,
    }),
    34,
  );
});

test('a mid-transition sample cannot collapse the baseline permanently', () => {
  // Found in review. The keyboard retracts, focus has already left the field so
  // the focus rule does not apply, and `interactive-widget=resizes-content` means
  // both numbers have to grow back — but not necessarily in the same tick. Read
  // between those two updates and `innerHeight` is still short while the visual
  // viewport has already sprung back.
  let baseline = reviseRestingViewportGap(null, {
    innerHeight: 852,
    viewportHeight: 818,
    textEntryFocused: false,
  });
  assert.equal(baseline, 34);

  baseline = reviseRestingViewportGap(baseline, {
    innerHeight: 518,
    viewportHeight: 818,
    textEntryFocused: false,
  });

  // Flooring that to 0 would stick: the baseline only ever shrinks, so no later
  // sample could raise it and the phantom gap would be back for the rest of the
  // session.
  assert.equal(baseline, 34);
  assert.equal(computeKeyboardHeight(852, 818, baseline ?? 0), 0);
});

test('isTextEntryElement recognises the focus that summons a keyboard', () => {
  assert.equal(isTextEntryElement({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEntryElement({ tagName: 'INPUT' }), true);
  assert.equal(isTextEntryElement({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTextEntryElement({ tagName: 'DIV' }), false);
  assert.equal(isTextEntryElement(null), false);
});

test('a document scroll is always a displacement — nothing here scrolls the document', () => {
  assert.equal(
    isViewportDisplaced({ scrollY: 120, viewportOffsetTop: 0, textEntryFocused: false }),
    true,
  );
});

test('a viewport offset without text focus is the URL bar, not the keyboard', () => {
  // Correcting this would fight the browser on every ordinary scroll.
  assert.equal(
    isViewportDisplaced({ scrollY: 0, viewportOffsetTop: 60, textEntryFocused: false }),
    false,
  );
  assert.equal(
    isViewportDisplaced({ scrollY: 0, viewportOffsetTop: 60, textEntryFocused: true }),
    true,
  );
});

test('publishes the keyboard height on resize', () => {
  const harness = makeHarness({ innerHeight: 800 });
  installKeyboardViewportSync(harness.win, harness.doc);

  openKeyboard(harness, 300, 0);
  harness.fireResize();
  // Two frames, not none: the read is deferred so both viewport numbers settle.
  harness.runFrames(2);

  assert.equal(harness.properties['--keyboard-height'], '300px');
});

test('undoes the displacement when WebKit scrolls before the resize lands (#334)', () => {
  const harness = makeHarness({ innerHeight: 800 });
  installKeyboardViewportSync(harness.win, harness.doc);

  // WebKit scrolled the focused composer into view against the pre-adjustment
  // layout. Left alone, the shell would be shortened by 300 *and* pushed up by
  // 290 — off the visible area, rendering blank.
  openKeyboard(harness, 300, 290);
  harness.fireResize();
  harness.runFrames(2);

  assert.equal(harness.properties['--keyboard-height'], '300px');
  assert.deepEqual(harness.scrollCalls, [[0, 0]]);
  assert.equal(harness.win.scrollY, 0);
});

test('undoes the displacement when WebKit scrolls after the resize lands', () => {
  const harness = makeHarness({ innerHeight: 800 });
  installKeyboardViewportSync(harness.win, harness.doc);

  // The other ordering — the resize arrives first, so the pin during it is a
  // no-op and the frame scheduled after it is what catches the displacement.
  openKeyboard(harness, 300, 0);
  harness.fireResize();
  assert.deepEqual(harness.scrollCalls, []);

  harness.win.scrollY = 290;
  harness.win.visualViewport!.offsetTop = 290;
  harness.runFrames();

  assert.deepEqual(harness.scrollCalls, [[0, 0]]);
});

test('focusing a field pins the viewport on the next frame', () => {
  const harness = makeHarness({ innerHeight: 800 });
  installKeyboardViewportSync(harness.win, harness.doc);

  harness.doc.activeElement = { tagName: 'TEXTAREA' };
  harness.fireFocusIn();
  // Sampling during the event is too early — WebKit has not moved anything yet.
  assert.deepEqual(harness.scrollCalls, []);

  harness.win.scrollY = 240;
  harness.win.visualViewport!.offsetTop = 240;
  harness.runFrames();

  assert.deepEqual(harness.scrollCalls, [[0, 0]]);
});

test('leaves an undisplaced viewport alone', () => {
  const harness = makeHarness({ innerHeight: 800 });
  installKeyboardViewportSync(harness.win, harness.doc);

  harness.doc.activeElement = { tagName: 'TEXTAREA' };
  harness.fireFocusIn();
  harness.fireViewportScroll();
  harness.runFrames();

  assert.deepEqual(harness.scrollCalls, []);
});

test('ordinary scrolling with no field focused is never corrected', () => {
  const harness = makeHarness({ innerHeight: 800 });
  installKeyboardViewportSync(harness.win, harness.doc);

  // The URL bar collapsing shifts offsetTop during a normal gesture.
  harness.win.visualViewport!.offsetTop = 45;
  harness.fireViewportScroll();
  harness.runFrames();

  assert.deepEqual(harness.scrollCalls, []);
});

test('teardown removes every listener', () => {
  const harness = makeHarness({ innerHeight: 800 });
  const uninstall = installKeyboardViewportSync(harness.win, harness.doc);
  uninstall();

  openKeyboard(harness, 300, 290);
  harness.fireResize();
  harness.fireFocusIn();
  harness.runFrames();

  assert.equal(harness.properties['--keyboard-height'], undefined);
  assert.deepEqual(harness.scrollCalls, []);
});

test('no Visual Viewport API means no wiring and a safe teardown', () => {
  const harness = makeHarness({ innerHeight: 800 });
  harness.win.visualViewport = null;

  const uninstall = installKeyboardViewportSync(harness.win, harness.doc);
  uninstall();

  assert.equal(harness.properties['--keyboard-height'], undefined);
});

/*
 * #346: "starting a new conversation, the keyboard completely covers the input
 * box."
 *
 * The shell raises its own bottom edge by `--keyboard-height`, which works for
 * the chat composer inside it. The mobile sidebar overlay — which hosts the
 * new-conversation folder picker and its search box — is itself
 * `position: fixed; inset: 0`, so it is laid out against the viewport and
 * inherits nothing from the shell's raised edge. It kept full height and its
 * content stayed behind the keyboard.
 *
 * Verified in a real mobile viewport before the fix: the picker's fixed
 * ancestor chain was [overlay bottom:0px (no inline style), shell bottom:
 * var(--keyboard-height, 0px)].
 */

test('keyboardAwareBottomStyle offsets by the published keyboard height', () => {
  assert.deepEqual(keyboardAwareBottomStyle(), { bottom: 'var(--keyboard-height, 0px)' });
});

test('keyboardAwareBottomStyle falls back to 0 so a desktop shell is unaffected', () => {
  // The fallback in the var() is what keeps every non-iOS surface at inset-0:
  // `installKeyboardViewportSync` never sets the property without a Visual
  // Viewport API, so the declaration must degrade on its own.
  assert.match(keyboardAwareBottomStyle().bottom, /,\s*0px\)$/);
});

test('keyboardAwareBottomStyle merges into an existing style object', () => {
  assert.deepEqual(keyboardAwareBottomStyle({ zIndex: 50 }), {
    zIndex: 50,
    bottom: 'var(--keyboard-height, 0px)',
  });
});

test('keyboardAwareBottomStyle always wins over an inherited bottom', () => {
  // A caller passing its own bottom is describing the non-keyboard case; the
  // keyboard offset is the whole point of opting in, so it must not be lost.
  assert.equal(
    keyboardAwareBottomStyle({ bottom: '0px' }).bottom,
    'var(--keyboard-height, 0px)',
  );
});

/*
 * #346 (the reported case): "starting a new conversation, the keyboard
 * completely covers the input box" — the chat composer, not the folder picker.
 *
 * The consuming side is provably fine: driving `--keyboard-height` to 300px in a
 * real 393x852 viewport shrinks the shell 852 -> 552 and lifts the composer's
 * bottom 786 -> 486, clear of the keyboard. So the failure is on the publishing
 * side, and there is exactly one publisher: `resize`.
 *
 * That is one event to miss. iOS fires `visualViewport` resize around the
 * keyboard animation, and a focus that arrives without one — the keyboard
 * already up from a previous field, a resize swallowed while the view was
 * mounting (which is what "starting a new conversation" does), a resize
 * sampled mid-animation — leaves the property unset and the shell full height.
 * Focus is the moment we know a keyboard is wanted, so sample the height there
 * too. Idempotent: if resize already published the right value, this rewrites
 * the same one.
 */

test('focusing a text field publishes the keyboard height even with no resize event', () => {
  const harness = makeHarness({ innerHeight: 852 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);

  // The keyboard is up but no resize arrived — the case that leaves the
  // composer stranded behind it today.
  harness.win.visualViewport!.height = 552;
  harness.doc.activeElement = { tagName: 'TEXTAREA' };

  harness.fireFocusIn();
  harness.runFrames();

  assert.equal(harness.properties['--keyboard-height'], '300px');
  teardown();
});

test('focusing re-samples after the frame, catching a mid-animation height', () => {
  const harness = makeHarness({ innerHeight: 852 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);
  harness.doc.activeElement = { tagName: 'INPUT' };

  // Focus lands while the keyboard is still sliding in: the viewport reports a
  // partial height, then settles. The settled value must be the one published.
  harness.win.visualViewport!.height = 700;
  harness.fireFocusIn();
  harness.win.visualViewport!.height = 552;
  harness.runFrames();

  assert.equal(harness.properties['--keyboard-height'], '300px');
  teardown();
});

test('focus keeps sampling until a late keyboard viewport settles without resize (#442)', () => {
  const harness = makeHarness({ innerHeight: 797 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);
  harness.doc.activeElement = { tagName: 'TEXTAREA' };

  // iOS has focused the composer, but the keyboard animation has not changed
  // the visual viewport yet. The old one-frame fallback samples this 0px state
  // and then stops.
  harness.fireFocusIn();
  harness.runFrames();
  assert.equal(harness.properties['--keyboard-height'], '0px');

  // The viewport later reaches the exact geometry captured in #442, without a
  // resize event the app can use: layout 797px, visible 394px. A bounded focus
  // sampling window must still publish the final 403px inset.
  harness.win.visualViewport!.height = 394;
  harness.runFrames();

  assert.equal(harness.properties['--keyboard-height'], '403px');
  teardown();
});

test('teardown stops an in-flight focus sampling window', () => {
  const harness = makeHarness({ innerHeight: 797 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);
  harness.doc.activeElement = { tagName: 'TEXTAREA' };

  harness.fireFocusIn();
  harness.runFrames();
  assert.equal(harness.properties['--keyboard-height'], '0px');

  teardown();
  harness.win.visualViewport!.height = 394;
  harness.runFrames();

  assert.equal(harness.properties['--keyboard-height'], '0px');
});

test('a new text focus supersedes the previous sampling window', () => {
  const harness = makeHarness({ innerHeight: 797 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);
  harness.doc.activeElement = { tagName: 'TEXTAREA' };

  harness.fireFocusIn();
  harness.doc.activeElement = { tagName: 'INPUT' };
  harness.fireFocusIn();
  assert.equal(harness.pendingFrameCount(), 2);

  // Both initial callbacks were queued already, but only the newest generation
  // is allowed to continue sampling.
  harness.runFrames();
  assert.equal(harness.pendingFrameCount(), 1);

  harness.win.visualViewport!.height = 394;
  harness.runFrames();
  assert.equal(harness.properties['--keyboard-height'], '403px');
  teardown();
});

test('focus sampling stops after its bounded settle window', () => {
  const harness = makeHarness({ innerHeight: 797 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);
  harness.doc.activeElement = { tagName: 'TEXTAREA' };

  harness.fireFocusIn();
  harness.runFrames(64); // 16ms steps span just over the 1000ms window.
  assert.equal(harness.pendingFrameCount(), 0);

  harness.win.visualViewport!.height = 394;
  harness.runFrames();
  assert.equal(harness.properties['--keyboard-height'], '0px');
  teardown();
});

test('focusing a non-text element does not publish a keyboard height', () => {
  const harness = makeHarness({ innerHeight: 852 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);

  harness.win.visualViewport!.height = 552;
  harness.doc.activeElement = { tagName: 'BUTTON' };

  harness.fireFocusIn();
  harness.runFrames();

  // A button press summons no keyboard; publishing one would shrink the shell
  // for nothing.
  assert.equal(harness.properties['--keyboard-height'], undefined);
  teardown();
});

test('focus publishing agrees with resize publishing (no fight between them)', () => {
  const harness = makeHarness({ innerHeight: 852 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);
  harness.doc.activeElement = { tagName: 'TEXTAREA' };

  openKeyboard(harness, 300, 0);
  harness.fireResize();
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '300px');

  harness.fireFocusIn();
  harness.runFrames();
  assert.equal(harness.properties['--keyboard-height'], '300px');
  teardown();
});

/*
 * #354/#442: the composer sits behind the keyboard from the home-screen icon,
 * and works in Safari — the only difference between those two being standalone
 * display mode, which no local harness can enter.
 *
 * Two publisher-side mechanisms fit that shape, and both are ported here from
 * wltiger/my-cloudcli, which hit them on the same lineage.
 *
 * The first is the baseline. Reading the keyboard as `innerHeight -
 * visualViewport.height` assumes the two agree when no keyboard is up. Standalone
 * iOS PWAs disagree by a constant — they do not settle whether the home-indicator
 * area belongs to the layout viewport — so the app publishes a phantom keyboard
 * at rest and the composer floats above a permanent gap.
 *
 * The second is timing. `index.html` asks for `interactive-widget=resizes-content`,
 * so the browser already shrinks `innerHeight` itself; reading in the same tick as
 * the resize can catch `innerHeight` before it does, measure the whole keyboard as
 * a gap, and shift the shell a second time on top of the browser's own.
 *
 * What follows pins the arithmetic and the ordering. It cannot pin the diagnosis:
 * every number below is one this file supplies, and standalone mode is exactly
 * where neither this suite nor the WebKit e2e sweep can go.
 */

test('a viewport that disagrees at rest publishes no phantom keyboard height', () => {
  // 852 layout against an 818 visual viewport with nothing focused: 34px of
  // standing disagreement, and no keyboard anywhere.
  const harness = makeHarness({ innerHeight: 852, viewportHeight: 818 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);

  harness.fireResize();
  harness.runFrames(2);

  assert.equal(harness.properties['--keyboard-height'], '0px');
  teardown();
});

test('the keyboard is measured above the resting gap, not from the raw difference', () => {
  const harness = makeHarness({ innerHeight: 852, viewportHeight: 818 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);

  harness.doc.activeElement = { tagName: 'TEXTAREA' };
  harness.win.visualViewport!.height = 518; // 818 visible, less a 300px keyboard.
  harness.fireResize();
  harness.runFrames(2);

  // 334px of raw difference, of which 34px was never the keyboard.
  assert.equal(harness.properties['--keyboard-height'], '300px');
  teardown();
});

test('a smaller resting gap observed later replaces the one seeded at install', () => {
  const harness = makeHarness({ innerHeight: 852, viewportHeight: 818 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);

  // A later resting sample says the true disagreement is 20px, not 34px.
  harness.win.visualViewport!.height = 832;
  harness.fireResize();
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '0px');

  // The next keyboard is measured against the revised figure.
  harness.doc.activeElement = { tagName: 'TEXTAREA' };
  harness.win.visualViewport!.height = 532;
  harness.fireResize();
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '300px');
  teardown();
});

test('a resting sample taken while the keyboard is still retracting cannot inflate the gap', () => {
  const harness = makeHarness({ innerHeight: 852, viewportHeight: 818 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);

  // Focus has already left the field but iOS has not finished sliding the
  // keyboard away, so this unfocused sample is still looking at one. Adopting it
  // as the baseline would recalibrate 300px of live keyboard as "resting", and
  // the retraction it is halfway through would be the last chance to notice.
  harness.doc.activeElement = null;
  harness.win.visualViewport!.height = 518;
  harness.fireResize();
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '300px');

  // It finishes retracting, and the app returns to rest.
  harness.win.visualViewport!.height = 818;
  harness.fireResize();
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '0px');

  // The next keyboard still measures its true height. Had the retracting sample
  // been adopted, this would publish 0 and the composer would be buried.
  harness.doc.activeElement = { tagName: 'TEXTAREA' };
  harness.win.visualViewport!.height = 518;
  harness.fireResize();
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '300px');
  teardown();
});

test('a baseline is not seeded from an install that happens with the keyboard up', () => {
  const harness = makeHarness({ innerHeight: 852, viewportHeight: 518 });
  harness.doc.activeElement = { tagName: 'TEXTAREA' };
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);

  // Nothing is known about the resting gap yet, so the whole difference is
  // published. Over-reporting costs a 34px gap; under-reporting puts the
  // composer behind the keyboard, and only one of those is the reported bug.
  harness.fireResize();
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '334px');

  // The keyboard closes, which is the first trustworthy sample there has been.
  harness.doc.activeElement = null;
  harness.win.visualViewport!.height = 818;
  harness.fireResize();
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '0px');

  // From here on the calibration holds, so the wrong seed does not persist.
  harness.doc.activeElement = { tagName: 'TEXTAREA' };
  harness.win.visualViewport!.height = 518;
  harness.fireResize();
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '300px');
  teardown();
});

test('a resize publishes the settled geometry, never a mid-transition sample', () => {
  const harness = makeHarness({ innerHeight: 852 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);
  harness.doc.activeElement = { tagName: 'TEXTAREA' };

  // The visual viewport has shrunk; `innerHeight` has not caught up yet, because
  // `interactive-widget=resizes-content` shrinks it on its own schedule. Read
  // here and the app publishes 300px on top of a native shift that is already
  // coming — the shell moves twice.
  harness.win.visualViewport!.height = 552;
  harness.fireResize();
  assert.equal(harness.properties['--keyboard-height'], undefined);

  // The layout viewport catches up. The browser has done the avoidance itself,
  // so there is nothing left for the app to add.
  harness.win.innerHeight = 552;
  harness.runFrames(2);
  assert.equal(harness.properties['--keyboard-height'], '0px');
  teardown();
});

test('teardown stops a deferred resize read still in flight', () => {
  const harness = makeHarness({ innerHeight: 852 });
  const teardown = installKeyboardViewportSync(harness.win, harness.doc);
  harness.doc.activeElement = { tagName: 'TEXTAREA' };

  harness.win.visualViewport!.height = 552;
  harness.fireResize();
  teardown();
  harness.runFrames(2);

  assert.equal(harness.properties['--keyboard-height'], undefined);
});

/*
 * The PWA-only CSS trap: `body.pwa-mode .fixed.inset-0` in `src/index.css` moves
 * the origin of anything carrying both classes down by the header safe area, and
 * `pwa-mode` is only added in standalone display mode. `--keyboard-height` is
 * derived from `window.innerHeight`, which is measured from y=0, so a shell
 * positioned by that rule is driven by a number from a coordinate space it does
 * not occupy — in the one environment no test can enter.
 */

test('viewportShellStyle spans the viewport from its true origin', () => {
  assert.deepEqual(viewportShellStyle(), {
    top: '0px',
    right: '0px',
    bottom: 'var(--keyboard-height, 0px)',
    left: '0px',
  });
});

test('viewportShellStyle keeps the keyboard-aware bottom edge', () => {
  // Spanning the viewport and clearing the keyboard are the same requirement for
  // a shell: it is the surface the published height was computed for.
  assert.equal(viewportShellStyle().bottom, keyboardAwareBottomStyle().bottom);
});

test('viewportShellStyle overrides an inset the caller supplied', () => {
  // The point of opting in is to state the inset inline so the PWA rule cannot
  // reach it. A caller's own `top` would be describing the trap, not escaping it.
  assert.deepEqual(viewportShellStyle({ zIndex: 50, top: '44px' }), {
    zIndex: 50,
    top: '0px',
    right: '0px',
    bottom: 'var(--keyboard-height, 0px)',
    left: '0px',
  });
});
