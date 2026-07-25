import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useFocusTrap } from './useFocusTrap';
import { useOverlayDismiss } from './useOverlayDismiss';

/*
 * #274: #243 gave the hand-rolled overlays Esc/backdrop dismissal but left
 * keyboard focus free to Tab straight out of the dialog and into the page
 * behind it. This hook is the shared opt-in for the other half — trapping Tab
 * inside the dialog and handing focus back to whatever opened it.
 *
 * The stacking rule from #243 has to hold here too: with the wizard and the
 * folder picker both mounted, only the picker traps. Both hooks read the *same*
 * ordered overlay stack (see `overlayLayers.ts`), so they cannot disagree about
 * which dialog is on top.
 */

function TrappedOverlay({
  label,
  isActive,
  onDismiss = () => {},
}: {
  label: string;
  isActive: boolean;
  onDismiss?: () => void;
}) {
  const { containerRef } = useFocusTrap<HTMLDivElement>({ isActive });
  const { backdropProps } = useOverlayDismiss({ isActive, onDismiss });

  if (!isActive) return null;

  return (
    <div {...backdropProps}>
      <div ref={containerRef} role="dialog" aria-label={label}>
        <button type="button">{label} first</button>
        <button type="button">{label} middle</button>
        <button type="button">{label} last</button>
      </div>
    </div>
  );
}

function PageWithOverlay({ isActive }: { isActive: boolean }) {
  return (
    <>
      <button type="button">behind the overlay</button>
      <TrappedOverlay label="dialog" isActive={isActive} />
    </>
  );
}

const activeName = () =>
  (document.activeElement as HTMLElement | null)?.textContent ?? document.activeElement?.nodeName;

describe('useFocusTrap (#274)', () => {
  it('moves focus into the dialog when it activates', () => {
    render(<PageWithOverlay isActive />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'dialog first' }));
  });

  it('wraps Tab from the last control back to the first', async () => {
    const user = userEvent.setup();
    render(<PageWithOverlay isActive />);

    screen.getByRole('button', { name: 'dialog last' }).focus();
    await user.tab();

    expect(activeName()).toBe('dialog first');
  });

  it('wraps Shift+Tab from the first control to the last', async () => {
    const user = userEvent.setup();
    render(<PageWithOverlay isActive />);

    screen.getByRole('button', { name: 'dialog first' }).focus();
    await user.tab({ shift: true });

    expect(activeName()).toBe('dialog last');
  });

  it('never lets Tab reach the page behind the overlay', async () => {
    const user = userEvent.setup();
    render(<PageWithOverlay isActive />);

    const dialog = screen.getByRole('dialog', { name: 'dialog' });
    const behind = screen.getByRole('button', { name: 'behind the overlay' });

    for (let press = 0; press < 8; press += 1) {
      await user.tab();
      expect(document.activeElement).not.toBe(behind);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('pulls focus back in when Tab is pressed from outside the dialog', async () => {
    const user = userEvent.setup();
    render(<PageWithOverlay isActive />);

    screen.getByRole('button', { name: 'behind the overlay' }).focus();
    await user.tab();

    expect(activeName()).toBe('dialog first');
  });

  it('lands on the last control when Shift+Tab comes from outside the dialog', async () => {
    const user = userEvent.setup();
    render(<PageWithOverlay isActive />);

    screen.getByRole('button', { name: 'behind the overlay' }).focus();
    await user.tab({ shift: true });

    expect(activeName()).toBe('dialog last');
  });

  it('restores focus to whatever opened the dialog when it closes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PageWithOverlay isActive={false} />);

    const opener = screen.getByRole('button', { name: 'behind the overlay' });
    opener.focus();

    rerender(<PageWithOverlay isActive />);
    expect(document.activeElement).not.toBe(opener);

    rerender(<PageWithOverlay isActive={false} />);
    expect(document.activeElement).toBe(opener);

    // And the page behind is reachable again once the trap is gone.
    await user.tab();
    expect(document.activeElement).not.toBe(opener);
  });

  it('prefers an explicit restore target over the previously focused element', () => {
    function WithTrigger({ isActive }: { isActive: boolean }) {
      const triggerRef = useRef<HTMLButtonElement | null>(null);
      const { containerRef } = useFocusTrap<HTMLDivElement>({
        isActive,
        restoreFocusRef: triggerRef,
      });

      return (
        <>
          <button type="button" ref={triggerRef}>
            trigger
          </button>
          <button type="button">somewhere else</button>
          {isActive && (
            <div ref={containerRef} role="dialog" aria-label="explicit">
              <button type="button">inside</button>
            </div>
          )}
        </>
      );
    }

    const { rerender } = render(<WithTrigger isActive={false} />);
    screen.getByRole('button', { name: 'somewhere else' }).focus();

    rerender(<WithTrigger isActive />);
    rerender(<WithTrigger isActive={false} />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'trigger' }));
  });

  it('does nothing while inactive', async () => {
    const user = userEvent.setup();
    render(<PageWithOverlay isActive={false} />);

    const behind = screen.getByRole('button', { name: 'behind the overlay' });
    behind.focus();
    await user.tab();

    expect(document.activeElement).not.toBe(behind);
  });

  it('swallows Tab when the dialog has nothing focusable', async () => {
    const user = userEvent.setup();

    function EmptyOverlay() {
      const { containerRef } = useFocusTrap<HTMLDivElement>({ isActive: true });
      return (
        <>
          <button type="button">behind the overlay</button>
          <div ref={containerRef} role="dialog" aria-label="empty">
            <p>nothing to focus here</p>
          </div>
        </>
      );
    }

    render(<EmptyOverlay />);
    await user.tab();

    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'behind the overlay' }),
    );
  });

  it('skips disabled controls when wrapping', async () => {
    const user = userEvent.setup();

    function OverlayWithDisabled() {
      const { containerRef } = useFocusTrap<HTMLDivElement>({ isActive: true });
      return (
        <div ref={containerRef} role="dialog" aria-label="disabled">
          <button type="button">enabled first</button>
          <button type="button" disabled>
            disabled last
          </button>
        </div>
      );
    }

    render(<OverlayWithDisabled />);
    await user.tab();

    expect(activeName()).toBe('enabled first');
  });
});

describe('useFocusTrap stacking (#274)', () => {
  it('traps in the topmost overlay and reverts to the one beneath when it closes', async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <>
        <TrappedOverlay label="outer" isActive />
        <TrappedOverlay label="inner" isActive />
      </>,
    );

    const inner = screen.getByRole('dialog', { name: 'inner' });
    screen.getByRole('button', { name: 'inner last' }).focus();
    await user.tab();

    expect(activeName()).toBe('inner first');
    expect(inner.contains(document.activeElement)).toBe(true);

    rerender(
      <>
        <TrappedOverlay label="outer" isActive />
        <TrappedOverlay label="inner" isActive={false} />
      </>,
    );

    const outer = screen.getByRole('dialog', { name: 'outer' });
    screen.getByRole('button', { name: 'outer last' }).focus();
    await user.tab();

    expect(activeName()).toBe('outer first');
    expect(outer.contains(document.activeElement)).toBe(true);
  });

  it('agrees with useOverlayDismiss about which overlay is on top', async () => {
    const user = userEvent.setup();
    const onDismissOuter = vi.fn();
    const onDismissInner = vi.fn();

    render(
      <>
        <TrappedOverlay label="outer" isActive onDismiss={onDismissOuter} />
        <TrappedOverlay label="inner" isActive onDismiss={onDismissInner} />
      </>,
    );

    // One stack, two concerns: Esc peels the inner overlay and Tab stays in it.
    await user.keyboard('{Escape}');
    expect(onDismissInner).toHaveBeenCalledTimes(1);
    expect(onDismissOuter).not.toHaveBeenCalled();

    screen.getByRole('button', { name: 'inner last' }).focus();
    await user.tab();
    expect(activeName()).toBe('inner first');
  });
});
