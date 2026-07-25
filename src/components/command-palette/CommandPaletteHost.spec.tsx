import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import CommandPaletteHost from './CommandPaletteHost';

/*
 * The palette is demand-loaded (issue #267), so the shortcut that opens it can
 * no longer live inside the palette itself — the listener would only be
 * installed after the chunk that the shortcut is supposed to fetch. This host
 * owns the listener and the open state; the palette is a controlled child.
 */

vi.mock('./CommandPalette', () => ({
  default: ({ open }: { open: boolean }) => <div data-testid="palette">{open ? 'open' : 'closed'}</div>,
}));

const noop = () => {};

function renderHost() {
  return render(
    <CommandPaletteHost selectedProject={null} onStartNewChat={noop} onOpenSettings={noop} onShowTab={noop} />,
  );
}

describe('CommandPaletteHost', () => {
  it('renders nothing until the shortcut is pressed', () => {
    const { container } = renderHost();

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('palette')).toBeNull();
  });

  it('mounts the palette open on the first Ctrl+K', async () => {
    const user = userEvent.setup();
    renderHost();

    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByTestId('palette')).toHaveTextContent('open');
  });

  it('toggles closed on a second press but keeps the palette mounted', async () => {
    const user = userEvent.setup();
    renderHost();

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByTestId('palette')).toHaveTextContent('open');

    await user.keyboard('{Control>}k{/Control}');

    // Still mounted — remounting would throw away the search sources' caches.
    expect(screen.getByTestId('palette')).toHaveTextContent('closed');
  });

  it('ignores Ctrl+Shift+K so it cannot shadow other shortcuts', async () => {
    const user = userEvent.setup();
    const { container } = renderHost();

    await user.keyboard('{Control>}{Shift>}k{/Shift}{/Control}');

    expect(container).toBeEmptyDOMElement();
  });
});
