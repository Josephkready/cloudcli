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
});
