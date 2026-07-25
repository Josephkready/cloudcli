import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import McpServerFormModal from './McpServerFormModal';

/*
 * #243: the MCP form modal is a hand-rolled `fixed inset-0` overlay with no
 * keydown handler, so Esc and backdrop clicks did nothing — unlike /help,
 * /status and Token Usage, which all close on Esc.
 */

function renderModal(overrides: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const result = render(
    <McpServerFormModal
      provider="claude"
      isOpen
      editingServer={null}
      currentProjects={[]}
      onClose={onClose}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { ...result, onClose, onSubmit };
}

describe('McpServerFormModal — Esc and backdrop dismissal (#243)', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click on the backdrop but not inside the dialog', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    const dialog = screen.getByRole('dialog');
    await user.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    await user.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays inert while closed', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({ isOpen: false });

    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
  });
});

/*
 * #274: the modal is portalled to the end of <body>, so Tab from its last
 * control fell off the end of the document and back into the settings page
 * behind it.
 */
describe('McpServerFormModal — focus trap (#274)', () => {
  function renderModalOverPage() {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const result = render(
      <>
        <button type="button">behind the modal</button>
        <McpServerFormModal
          provider="claude"
          isOpen
          editingServer={null}
          currentProjects={[]}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      </>,
    );
    return { ...result, onClose, onSubmit };
  }

  it('moves focus into the modal when it opens', () => {
    renderModalOverPage();

    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('never lets Tab reach the page behind the modal', async () => {
    const user = userEvent.setup();
    renderModalOverPage();

    const dialog = screen.getByRole('dialog');
    const behind = screen.getByRole('button', { name: 'behind the modal' });

    for (let press = 0; press < 12; press += 1) {
      await user.tab();
      expect(document.activeElement).not.toBe(behind);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  /*
   * Asserting only "still inside the dialog" is not enough here: the modal is
   * portalled, so a backward Tab from <body> lands inside it by document order
   * anyway and the test would pass with the trap removed. Pin the actual wrap —
   * focus on the first control, Shift+Tab, expect the last.
   */
  it('wraps Shift+Tab from the first control back to the last', async () => {
    const user = userEvent.setup();
    renderModalOverPage();

    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusable.length).toBeGreaterThan(1);

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    first.focus();
    expect(document.activeElement).toBe(first);

    await user.tab({ shift: true });

    expect(document.activeElement).toBe(last);
  });

  it('never lets Shift+Tab reach the page behind the modal', async () => {
    const user = userEvent.setup();
    renderModalOverPage();

    const dialog = screen.getByRole('dialog');
    const behind = screen.getByRole('button', { name: 'behind the modal' });

    for (let press = 0; press < 12; press += 1) {
      await user.tab({ shift: true });
      expect(document.activeElement).not.toBe(behind);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('restores focus to the opener when the modal closes', () => {
    const opener = document.createElement('button');
    opener.textContent = 'open mcp form';
    document.body.append(opener);
    opener.focus();

    const props = {
      provider: 'claude' as const,
      editingServer: null,
      currentProjects: [],
      onClose: vi.fn(),
      onSubmit: vi.fn().mockResolvedValue(undefined),
    };

    const { rerender } = render(<McpServerFormModal isOpen={false} {...props} />);
    rerender(<McpServerFormModal isOpen {...props} />);
    expect(document.activeElement).not.toBe(opener);

    rerender(<McpServerFormModal isOpen={false} {...props} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
