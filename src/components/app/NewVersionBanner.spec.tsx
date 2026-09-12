import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NewVersionBanner from './NewVersionBanner';

/**
 * cloudcli#458: a stale tab keeps running an old bundle with no way to notice a new
 * deploy. The banner must (a) appear without blocking the UI, (b) reload only on an
 * explicit click, and (c) auto-reload ONLY on a return-from-hidden while the app is
 * idle — never mid-conversation.
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

  const show = (isIdle: () => boolean = () => true) => {
    render(<NewVersionBanner newBuildAvailable isIdle={isIdle} />);
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
    const { container } = render(<NewVersionBanner newBuildAvailable={false} isIdle={() => true} />);
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

  it('auto-reloads when returning from hidden while idle', () => {
    show();
    goHidden();
    expect(reload).not.toHaveBeenCalled();

    returnVisible();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never auto-reloads while the app is not idle (in-flight stream / unsent composer text)', () => {
    show(() => false);
    goHidden();

    returnVisible();
    expect(reload).not.toHaveBeenCalled();
  });

  it('evaluates idleness at decision time, not render time', () => {
    // Idle at render, busy at the return-from-hidden moment — the decision must use
    // the fresh answer so a keystroke landing between renders still blocks the reload.
    let idle = true;
    show(() => idle);
    goHidden();

    idle = false;
    returnVisible();
    expect(reload).not.toHaveBeenCalled();
  });
});
