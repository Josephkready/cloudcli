import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import McpServerFormModal from '../mcp/view/modals/McpServerFormModal';
import NewBranchModal from '../git-panel/view/modals/NewBranchModal';

/**
 * The overlay element itself carries the keyboard offset (#357).
 *
 * This sits between the two other checks and covers what neither does.
 * `keyboardOverlayCoverage.test.ts` greps the source, so it proves a *file*
 * mentions the offset — it would still pass if the style landed on the wrong
 * element, or on the backdrop instead of the centring container. The e2e sweep
 * measures real geometry but only for surfaces reachable in a browser test;
 * these modals sit behind settings and the git panel.
 *
 * So: assert the offset is on the element whose box does the centring.
 */

/**
 * The dialog's centring container — the `fixed inset-0` ancestor.
 *
 * Found by walking up rather than by test id, because which element that is
 * differs per modal and pinning it structurally is the point: if a refactor
 * moves the centring to a different element, this fails rather than quietly
 * checking the wrong box.
 */
function centringContainer(dialog: HTMLElement): HTMLElement {
  let node: HTMLElement | null = dialog.parentElement;
  while (node) {
    if (node.className.includes('fixed inset-0') && node.className.includes('items-center')) {
      return node;
    }
    node = node.parentElement;
  }
  throw new Error('no fixed inset-0 centring container found above the dialog');
}

describe('hand-rolled overlays clear the soft keyboard (#357)', () => {
  it('MCP server form offsets its centring container', () => {
    render(
      <McpServerFormModal
        provider="claude"
        isOpen
        editingServer={null}
        currentProjects={[]}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const container = centringContainer(screen.getByRole('dialog'));
    expect(container.style.bottom).toBe('var(--keyboard-height, 0px)');
  });

  it('new-branch modal offsets its centring container but not its backdrop', () => {
    render(
      <NewBranchModal
        isOpen
        currentBranch="main"
        isCreatingBranch={false}
        onClose={vi.fn()}
        onCreateBranch={vi.fn().mockResolvedValue(true)}
      />,
    );

    const container = centringContainer(screen.getByRole('dialog'));
    expect(container.style.bottom).toBe('var(--keyboard-height, 0px)');

    // The backdrop must stay full-screen, or the area behind the keyboard is
    // left undimmed — a visible seam rather than a covered one.
    const backdrop = container.querySelector<HTMLElement>('.fixed.inset-0');
    expect(backdrop).not.toBeNull();
    expect(backdrop!.style.bottom).toBe('');
  });
});
