import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetBackDismissForTest, registerBackDismiss } from './overlayBackDismiss';

/*
 * #365: the phone Back gesture must peel exactly one overlay at a time (not leave
 * the app, not double-close a stacked pair). These pin the controller's history
 * bookkeeping without a real browser: pushState/back are spied, and a Back is a
 * dispatched popstate.
 */

describe('overlayBackDismiss (#365)', () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;
  let backSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetBackDismissForTest();
    pushSpy = vi.spyOn(window.history, 'pushState');
    backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetBackDismissForTest();
  });

  const pressBack = () => window.dispatchEvent(new PopStateEvent('popstate'));

  it('pushes one sentinel history entry when an overlay opens', () => {
    registerBackDismiss(vi.fn());
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('carries the existing history state onto the sentinel so react-router idx survives', () => {
    // react-router stamps { idx, key, usr } on its entries; a marker-only sentinel
    // would leave idx undefined and corrupt a later navigate() into NaN.
    window.history.replaceState({ idx: 3, key: 'abc' }, '');
    registerBackDismiss(vi.fn());
    const state = window.history.state as { idx?: number; __overlayBackDismiss?: boolean };
    expect(state.__overlayBackDismiss).toBe(true);
    expect(state.idx).toBe(3);
  });

  it('Back closes only the topmost overlay, one layer per press', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const unregA = registerBackDismiss(closeA);
    const unregB = registerBackDismiss(closeB);

    pressBack();
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();

    // B was closed by Back, so its sentinel is already gone — its unregister must
    // NOT history.back() a second time.
    unregB();
    expect(backSpy).not.toHaveBeenCalled();

    // A is now topmost; the next Back closes it.
    pressBack();
    expect(closeA).toHaveBeenCalledTimes(1);
    unregA();
  });

  it('a programmatic close pops its own sentinel without closing the overlay below', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    registerBackDismiss(closeA); // underneath
    const unregB = registerBackDismiss(closeB); // on top

    // Close B via Esc/X (not Back): its cleanup pops B's sentinel with history.back().
    unregB();
    expect(backSpy).toHaveBeenCalledTimes(1);

    // The popstate the browser then fires for that cleanup back must be swallowed,
    // NOT treated as a user Back that would wrongly close A too.
    pressBack();
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
  });

  it('counts self-inflicted pops so two programmatic closes in one tick do not desync', () => {
    const closeA = vi.fn(); // stays open at the bottom
    const closeB = vi.fn();
    const closeC = vi.fn();
    registerBackDismiss(closeA);
    const unregB = registerBackDismiss(closeB);
    const unregC = registerBackDismiss(closeC);

    // Close C then B programmatically before either popstate fires — two queued
    // history.back()s. A single boolean guard would swallow only the first and
    // let the second popstate wrongly close A.
    unregC();
    unregB();
    expect(backSpy).toHaveBeenCalledTimes(2);

    pressBack();
    pressBack();
    expect(closeA).not.toHaveBeenCalled();

    // A genuine Back now closes the remaining topmost overlay (A).
    pressBack();
    expect(closeA).toHaveBeenCalledTimes(1);
  });
});
