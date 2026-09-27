import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../project-creation-wizard/data/workspaceApi', () => ({
  browseFilesystemFolders: vi.fn().mockResolvedValue({ path: '~', suggestions: [] }),
  createFolderInFilesystem: vi.fn(),
}));

import FolderBrowserModal from '../project-creation-wizard/components/FolderBrowserModal';

/**
 * The overlay element itself carries the keyboard offset (#357).
 *
 * This sits between the two other checks and covers what neither does.
 * `keyboardOverlayCoverage.test.ts` greps the source, so it proves a *file*
 * mentions the offset — it would still pass if the style landed on the wrong
 * element, or on the backdrop instead of the centring container. The e2e sweep
 * measures real geometry but only for surfaces reachable in a browser test;
 * this modal sits behind settings.
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
  it('folder browser modal offsets its centring container', async () => {
    render(
      <FolderBrowserModal
        isOpen
        autoAdvanceOnSelect={false}
        onClose={vi.fn()}
        onFolderSelected={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    const container = centringContainer(screen.getByRole('dialog'));
    expect(container.style.bottom).toBe('var(--keyboard-height, 0px)');
  });
});
