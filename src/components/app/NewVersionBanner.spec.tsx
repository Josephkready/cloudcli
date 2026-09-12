import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NewVersionBanner from './NewVersionBanner';

/**
 * cloudcli#458: a stale tab keeps running an old bundle with no way to notice a new
 * deploy. The banner must (a) appear without blocking the UI, (b) reload only on an
 * explicit click, and (c) auto-reload ONLY on a return-from-hidden while the app is
 * idle — never mid-conversation — and (d) base that resume decision on a FRESH
 * `checkNow()` answer rather than the `newBuildAvailable` prop, which cannot yet reflect
 * a build that landed while the tab was backgrounded (the race the #458 PR review caught:
 * the prop only updates once useVersionCheck's own fetch resolves and re-renders, which
 * cannot happen inside the same synchronous `visibilitychange` dispatch this fires).
 */

describe('NewVersionBanner', () => {
  const reload = vi.fn();

  beforeEach(() => {
    reload.mockReset();
    // jsdom's `location.reload` throws "Not implemented"; replace it wholesale (it is a
    // non-configurable property, so spyOn cannot survive a restore).
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  const show = (
    isIdle: () => boolean = () => true,
    checkNow: () => Promise<boolean> = () => Promise.resolve(true),
  ) => {
    render(<NewVersionBanner newBuildAvailable isIdle={isIdle} checkNow={checkNow} />);
  };

  const goHidden = () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
  };

  const returnVisible = () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
  };

  it('renders nothing while no new build is available', () => {
    const { container } = render(
      <NewVersionBanner newBuildAvailable={false} isIdle={() => true} checkNow={() => Promise.resolve(false)} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a reload banner with a manual reload button and a dismiss control', async () => {
    show();

    expect(screen.getByText('New version available')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('lets the user dismiss the banner without reloading', () => {
    show();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('New version available')).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not auto-reload on the initial render (no return-from-hidden yet)', () => {
    show();
    expect(reload).not.toHaveBeenCalled();
  });

  it('auto-reloads when returning from hidden while idle and checkNow confirms a new build', async () => {
    const checkNow = vi.fn(() => Promise.resolve(true));
    show(() => true, checkNow);
    goHidden();
    expect(reload).not.toHaveBeenCalled();

    returnVisible();
    await waitFor(() => expect(checkNow).toHaveBeenCalledTimes(1));
    await checkNow.mock.results[0]!.value;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not auto-reload on resume when checkNow finds no new build yet, even though the newBuildAvailable prop is already true', async () => {
    // This is the race the #458 PR review caught: a build that landed while the tab was
    // backgrounded has not been picked up by any fetch when the resume event fires, so
    // the decision must use checkNow's fresh answer, never the (necessarily stale) prop.
    const checkNow = vi.fn(() => Promise.resolve(false));
    show(() => true, checkNow);
    goHidden();
    returnVisible();

    await waitFor(() => expect(checkNow).toHaveBeenCalledTimes(1));
    await checkNow.mock.results[0]!.value;
    expect(reload).not.toHaveBeenCalled();
  });

  it('never auto-reloads while the app is not idle (in-flight stream / unsent composer text)', async () => {
    const checkNow = vi.fn(() => Promise.resolve(true));
    show(() => false, checkNow);
    goHidden();

    returnVisible();
    await waitFor(() => expect(checkNow).toHaveBeenCalledTimes(1));
    await checkNow.mock.results[0]!.value;
    expect(reload).not.toHaveBeenCalled();
  });

  it('evaluates idleness at decision time, not render time', async () => {
    // Idle at render, busy at the return-from-hidden moment — the decision must use
    // the fresh answer so a keystroke landing between renders still blocks the reload.
    let idle = true;
    const checkNow = vi.fn(() => Promise.resolve(true));
    show(() => idle, checkNow);
    goHidden();

    idle = false;
    returnVisible();
    await waitFor(() => expect(checkNow).toHaveBeenCalledTimes(1));
    await checkNow.mock.results[0]!.value;
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload — or even re-check — a second time once an auto-reload has already fired', async () => {
    // Once reload() has been called the page is on its way out; a further resume event
    // (which the real browser will not actually deliver mid-navigation, but a test can
    // still fire synchronously) must not re-check or reload again.
    const checkNow = vi.fn(() => Promise.resolve(true));
    show(() => true, checkNow);
    goHidden();
    returnVisible();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    goHidden();
    returnVisible();
    expect(checkNow).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('removes its visibilitychange listener on unmount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(
      <NewVersionBanner newBuildAvailable isIdle={() => true} checkNow={() => Promise.resolve(true)} />,
    );
    const [, listener] = addSpy.mock.calls.find(([type]) => type === 'visibilitychange')!;

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', listener);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
