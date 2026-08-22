import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetBackDismissForTest } from './overlayBackDismiss';
import { useOverlayDismiss } from './useOverlayDismiss';

/*
 * #243: several dialogs are hand-rolled `fixed inset-0` overlays rather than
 * the shared Dialog primitive, so Esc and backdrop clicks did nothing. This
 * hook is the shared opt-in they use. The stacking rule matters because the
 * folder picker renders *inside* the project wizard — one Esc must close only
 * the topmost overlay.
 */

function Overlay({
  label,
  isActive,
  onDismiss,
}: {
  label: string;
  isActive: boolean;
  onDismiss: () => void;
}) {
  const { backdropProps } = useOverlayDismiss({ isActive, onDismiss });

  if (!isActive) return null;

  return (
    <div data-testid={`${label}-backdrop`} {...backdropProps}>
      <div data-testid={`${label}-content`}>
        <button type="button">inside {label}</button>
      </div>
    </div>
  );
}

describe('useOverlayDismiss (#243)', () => {
  // The Back-to-dismiss controller (#365) is a module singleton that mutates
  // window.history; reset it and stub the cleanup back() between cases so tests
  // don't pollute each other's history stack.
  beforeEach(() => {
    __resetBackDismissForTest();
    vi.spyOn(window.history, 'back').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetBackDismissForTest();
  });

  const pressBack = () => window.dispatchEvent(new PopStateEvent('popstate'));

  it('dismisses on Escape', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Overlay label="a" isActive onDismiss={onDismiss} />);

    await user.keyboard('{Escape}');

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses on a click on the backdrop itself', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Overlay label="a" isActive onDismiss={onDismiss} />);

    await user.click(screen.getByTestId('a-backdrop'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('prevents the backdrop press from stealing restored focus', () => {
    const onDismiss = vi.fn();
    render(<Overlay label="a" isActive onDismiss={onDismiss} />);

    const allowedDefault = fireEvent.mouseDown(screen.getByTestId('a-backdrop'));

    expect(allowedDefault).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks that land on the dialog content', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Overlay label="a" isActive onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: 'inside a' }));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does nothing while inactive', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Overlay label="a" isActive={false} onDismiss={onDismiss} />);

    await user.keyboard('{Escape}');

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('Escape only dismisses the topmost overlay when two are stacked', async () => {
    const user = userEvent.setup();
    const onDismissOuter = vi.fn();
    const onDismissInner = vi.fn();

    render(
      <>
        <Overlay label="outer" isActive onDismiss={onDismissOuter} />
        <Overlay label="inner" isActive onDismiss={onDismissInner} />
      </>,
    );

    await user.keyboard('{Escape}');

    expect(onDismissInner).toHaveBeenCalledTimes(1);
    expect(onDismissOuter).not.toHaveBeenCalled();
  });

  it('dismisses on the Back gesture (popstate) — the #365 wiring', () => {
    const onDismiss = vi.fn();
    render(<Overlay label="a" isActive onDismiss={onDismiss} />);

    pressBack();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Back only dismisses the topmost overlay when two are stacked', () => {
    const onDismissOuter = vi.fn();
    const onDismissInner = vi.fn();

    render(
      <>
        <Overlay label="outer" isActive onDismiss={onDismissOuter} />
        <Overlay label="inner" isActive onDismiss={onDismissInner} />
      </>,
    );

    pressBack();

    expect(onDismissInner).toHaveBeenCalledTimes(1);
    expect(onDismissOuter).not.toHaveBeenCalled();
  });

  it('does not respond to Back while inactive', () => {
    const onDismiss = vi.fn();
    render(<Overlay label="a" isActive={false} onDismiss={onDismiss} />);

    pressBack();

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('releases its slot on unmount so the overlay beneath becomes dismissable', async () => {
    const user = userEvent.setup();
    const onDismissOuter = vi.fn();
    const onDismissInner = vi.fn();

    const { rerender } = render(
      <>
        <Overlay label="outer" isActive onDismiss={onDismissOuter} />
        <Overlay label="inner" isActive onDismiss={onDismissInner} />
      </>,
    );

    rerender(
      <>
        <Overlay label="outer" isActive onDismiss={onDismissOuter} />
        <Overlay label="inner" isActive={false} onDismiss={onDismissInner} />
      </>,
    );

    await user.keyboard('{Escape}');

    expect(onDismissOuter).toHaveBeenCalledTimes(1);
    expect(onDismissInner).not.toHaveBeenCalled();
  });
});
