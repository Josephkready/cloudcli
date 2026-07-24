import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useEditorKeyboardShortcuts } from './useEditorKeyboardShortcuts';

/*
 * #231: the Escape branch called preventDefault() on *every* Escape before
 * doing anything else, so an editor open anywhere on the page swallowed the key
 * from other components — and closed itself in response to an Escape that was
 * meant for an unrelated popover or search box.
 */

function Harness({ onSave, onClose }: { onSave: () => void; onClose: () => void }) {
  useEditorKeyboardShortcuts({ onSave, onClose, dependency: 'x' });
  return null;
}

function setup() {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const result = render(<Harness onSave={onSave} onClose={onClose} />);
  return { ...result, onSave, onClose };
}

const dispatchKey = (init: KeyboardEventInit & { key: string }) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
};

describe('useEditorKeyboardShortcuts (#231)', () => {
  it('requests a close on Escape', () => {
    const { onClose } = setup();

    const event = dispatchKey({ key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores an Escape another component already handled', () => {
    const { onClose } = setup();

    // A popover / search box that handled the key first marks it consumed.
    document.addEventListener('keydown', (event) => event.preventDefault(), { once: true, capture: true });
    dispatchKey({ key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('still saves on Ctrl+S and Cmd+S', () => {
    const { onSave } = setup();

    dispatchKey({ key: 's', ctrlKey: true });
    dispatchKey({ key: 's', metaKey: true });

    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('leaves an unmodified keystroke alone', () => {
    const { onSave, onClose } = setup();

    const event = dispatchKey({ key: 's' });

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('detaches on unmount', () => {
    const { onClose, unmount } = setup();

    unmount();
    dispatchKey({ key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });
});
