import { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './Dialog';

describe('Dialog', () => {
  it('opens uncontrolled on trigger click and closes via the overlay click', () => {
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <p>Body</p>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(document.querySelector('[aria-hidden="true"]')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('calls onPointerDownOutside before closing on overlay click', () => {
    const onPointerDownOutside = vi.fn();
    render(
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent onPointerDownOutside={onPointerDownOutside}>content</DialogContent>
      </Dialog>,
    );

    fireEvent.click(document.querySelector('[aria-hidden="true"]')!);
    expect(onPointerDownOutside).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape and runs onEscapeKeyDown', () => {
    const onEscapeKeyDown = vi.fn();
    render(
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent onEscapeKeyDown={onEscapeKeyDown}>content</DialogContent>
      </Dialog>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('works as a controlled component, calling onOpenChange rather than managing state itself', () => {
    const onOpenChange = vi.fn();
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <Dialog open={open} onOpenChange={(next) => { setOpen(next); onOpenChange(next); }}>
          <DialogTrigger>Open</DialogTrigger>
          <DialogContent>content</DialogContent>
        </Dialog>
      );
    }
    render(<Controlled />);

    fireEvent.click(screen.getByText('Open'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('supports asChild on DialogTrigger, composing the child\'s own onClick and forwarding a ref', () => {
    const childOnClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Dialog>
        <DialogTrigger asChild ref={ref}>
          <button type="button" onClick={childOnClick}>Custom trigger</button>
        </DialogTrigger>
        <DialogContent>content</DialogContent>
      </Dialog>,
    );

    fireEvent.click(screen.getByText('Custom trigger'));
    expect(childOnClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(ref.current).not.toBeNull();
  });

  it('DialogTrigger forwards a callback ref and an onClick prop when not asChild', () => {
    const handleClick = vi.fn();
    let node: HTMLButtonElement | null = null;
    render(
      <Dialog>
        <DialogTrigger onClick={handleClick} ref={(el) => { node = el; }}>Open</DialogTrigger>
        <DialogContent>content</DialogContent>
      </Dialog>,
    );

    fireEvent.click(screen.getByText('Open'));
    expect(handleClick).toHaveBeenCalledTimes(1);
    expect(node).not.toBeNull();
  });

  it('throws when Dialog subcomponents are used outside a Dialog', () => {
    // Suppress React's expected error-boundary console noise for this assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<DialogTrigger>Open</DialogTrigger>)).toThrow(
      'Dialog components must be used within <Dialog>',
    );
    spy.mockRestore();
  });

  it('applies wrapperClassName and a DialogContent ref, and DialogTitle stays screen-reader-only', () => {
    const contentRef = createRef<HTMLDivElement>();
    render(
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent ref={contentRef} wrapperClassName="custom-wrapper">
          <DialogTitle>Hidden title</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(document.querySelector('.custom-wrapper')).toBeTruthy();
    expect(contentRef.current).not.toBeNull();
    expect(screen.getByText('Hidden title').className).toContain('sr-only');
  });
});
