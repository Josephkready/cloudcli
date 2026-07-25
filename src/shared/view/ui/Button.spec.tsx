import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { disabledControlClasses } from './disabledState';
import { Input } from './Input';

/*
 * #276 dropped `disabled:pointer-events-none` from Button so a blocked control
 * stays hit-testable and can explain itself (cursor / title tooltip). That is
 * only safe while the native `disabled` attribute is the thing blocking
 * activation, which in turn is only true while Button renders a real <button>.
 * These tests hold both halves of that bargain.
 */

const VARIANTS = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const;

describe('Button activation when disabled', () => {
  it('renders a native <button>, so `disabled` really blocks activation', () => {
    // If Button ever grows an asChild/Slot escape hatch (rendering an <a> or a
    // <div>), `disabled` becomes a no-op attribute and removing
    // pointer-events-none would make a "disabled" control clickable. Fail here
    // first and force that decision to be made deliberately.
    render(<Button disabled>Blocked</Button>);
    const button = screen.getByText('Blocked');
    expect(button.tagName).toBe('BUTTON');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(VARIANTS)('does not fire onClick when disabled (variant: %s)', async (variant) => {
    const onClick = vi.fn();
    render(
      <Button disabled variant={variant} onClick={onClick}>
        Blocked
      </Button>,
    );

    await userEvent.click(screen.getByText('Blocked'));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not leak the click to an ancestor handler either', async () => {
    const onClick = vi.fn();
    const onContainerClick = vi.fn();
    render(
      <div onClick={onContainerClick}>
        <Button disabled onClick={onClick}>
          Blocked
        </Button>
      </div>,
    );

    await userEvent.click(screen.getByText('Blocked'));

    expect(onClick).not.toHaveBeenCalled();
    expect(onContainerClick).not.toHaveBeenCalled();
  });

  it('still fires onClick when enabled', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);

    await userEvent.click(screen.getByText('Go'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps blocking activation when a call site passes its own className', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled className="bg-emerald-600" onClick={onClick}>
        Blocked
      </Button>,
    );

    await userEvent.click(screen.getByText('Blocked'));

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Button and Input agree on the disabled treatment', () => {
  const disabledTokens = disabledControlClasses.split(/\s+/);

  it('both carry the shared treatment on every Button variant', () => {
    for (const variant of VARIANTS) {
      const { unmount } = render(
        <Button disabled variant={variant}>
          Blocked
        </Button>,
      );
      const classes = screen.getByText('Blocked').className.split(/\s+/);
      expect(classes, `variant ${variant}`).toEqual(expect.arrayContaining(disabledTokens));
      unmount();
    }
  });

  it('Input carries the same treatment as Button', () => {
    render(<Input disabled aria-label="blocked field" />);
    const classes = screen.getByLabelText('blocked field').className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(disabledTokens));
  });

  it('neither suppresses pointer events on the control itself', () => {
    // `[&_svg]:pointer-events-none` (icons) is fine and must survive; what must
    // not come back is a rule that makes the disabled control itself inert.
    const suppressed = 'disabled:pointer-events'.concat('-none');

    render(<Button disabled>Blocked</Button>);
    render(<Input disabled aria-label="blocked field" />);

    expect(screen.getByText('Blocked').className).not.toContain(suppressed);
    expect(screen.getByLabelText('blocked field').className).not.toContain(suppressed);
  });
});
