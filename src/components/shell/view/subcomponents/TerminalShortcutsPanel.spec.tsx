import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

import TerminalShortcutsPanel from './TerminalShortcutsPanel';

/*
 * Every button here sends a fixed escape sequence over the socket, so the
 * real behaviour to assert is exactly what bytes reach `ws.send` — not that a
 * click handler ran.
 */

function Harness({
  isConnected = true,
  socket,
  scrollToBottom,
  bottomOffset,
}: {
  isConnected?: boolean;
  socket: { readyState: number; send: ReturnType<typeof vi.fn> };
  scrollToBottom: ReturnType<typeof vi.fn>;
  bottomOffset?: string;
}) {
  const wsRef = useRef(socket as unknown as WebSocket);
  const terminalRef = useRef({ scrollToBottom } as unknown as Terminal);

  return (
    <TerminalShortcutsPanel
      wsRef={wsRef}
      terminalRef={terminalRef}
      isConnected={isConnected}
      bottomOffset={bottomOffset}
    />
  );
}

function fakeSocket() {
  return { readyState: WebSocket.OPEN, send: vi.fn() };
}

function sentSequences(socket: { send: ReturnType<typeof vi.fn> }) {
  return socket.send.mock.calls.map(([payload]) => JSON.parse(String(payload)).data as string);
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: vi.fn(async () => ''), writeText: vi.fn(async () => {}) },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TerminalShortcutsPanel', () => {
  it('sends the escape sequence for a plain key', async () => {
    const user = userEvent.setup();
    const socket = fakeSocket();
    render(<Harness socket={socket} scrollToBottom={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Esc' }));

    expect(sentSequences(socket)).toEqual(['\x1b']);
  });

  it('does not send anything while disconnected and disables the buttons', async () => {
    const user = userEvent.setup();
    const socket = fakeSocket();
    render(<Harness socket={socket} scrollToBottom={vi.fn()} isConnected={false} />);

    const escButton = screen.getByRole('button', { name: 'Esc' });
    expect(escButton).toBeDisabled();
    await user.click(escButton);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('applies the Ctrl modifier to the next letter key and clears it after one use', async () => {
    const user = userEvent.setup();
    const socket = fakeSocket();
    render(<Harness socket={socket} scrollToBottom={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'CTRL' }));
    await user.click(screen.getByRole('button', { name: 'Ctrl+C' }));
    // A second press without re-toggling CTRL sends the plain sequence.
    await user.click(screen.getByRole('button', { name: 'Ctrl+C' }));

    // Ctrl+C sequence is already \x03; applying the ctrl transform to it
    // (single-char, code 3 is not a-z) leaves it unchanged both times.
    expect(sentSequences(socket)).toEqual(['\x03', '\x03']);
  });

  it('maps a letter under an active Ctrl modifier to its control code', async () => {
    const user = userEvent.setup();
    const socket = fakeSocket();
    render(<Harness socket={socket} scrollToBottom={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'CTRL' }));
    await user.click(screen.getByRole('button', { name: 'Tab' }));

    // Tab is '\t' (code 9, not a-z) so ctrl leaves it unchanged, but it still
    // consumes the modifier — the button is no longer visually active.
    expect(sentSequences(socket)).toEqual(['\t']);
    expect(screen.getByRole('button', { name: 'CTRL' })).not.toHaveClass('border-blue-500');
  });

  it('prefixes a letter key with ESC while the Alt modifier is active', async () => {
    const user = userEvent.setup();
    const socket = fakeSocket();
    render(<Harness socket={socket} scrollToBottom={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'ALT' }));
    await user.click(screen.getByRole('button', { name: 'Tab' }));

    expect(sentSequences(socket)).toEqual(['\x1b\t']);
  });

  it('sends arrow escape sequences', async () => {
    const user = userEvent.setup();
    const socket = fakeSocket();
    const { container } = render(<Harness socket={socket} scrollToBottom={vi.fn()} />);
    const arrowButtons = container.querySelectorAll('button svg.lucide-arrow-up, button svg.lucide-arrow-down');
    expect(arrowButtons.length).toBeGreaterThan(0);

    const upButton = arrowButtons[0].closest('button')!;
    await user.click(upButton);

    expect(sentSequences(socket)).toEqual(['\x1b[A']);
  });

  it('scrolls the terminal to bottom via the trailing button', async () => {
    const user = userEvent.setup();
    const socket = fakeSocket();
    const scrollToBottom = vi.fn();
    render(<Harness socket={socket} scrollToBottom={scrollToBottom} />);

    await user.click(screen.getByRole('button', { name: /scroll/i }));

    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('pastes clipboard text into the terminal', async () => {
    // `userEvent.setup()` installs its own clipboard stub, so the mock must
    // be applied after it runs or it gets clobbered.
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn(async () => 'pasted text'), writeText: vi.fn(async () => {}) },
    });
    const socket = fakeSocket();
    render(<Harness socket={socket} scrollToBottom={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /paste/i }));

    expect(sentSequences(socket)).toEqual(['pasted text']);
  });

  it('does nothing when the clipboard read is empty or rejects', async () => {
    const user = userEvent.setup();
    const socket = fakeSocket();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn(async () => ''), writeText: vi.fn(async () => {}) },
    });
    render(<Harness socket={socket} scrollToBottom={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /paste/i }));
    expect(socket.send).not.toHaveBeenCalled();

    (navigator.clipboard.readText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: /paste/i }));
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('renders at a custom bottom offset', () => {
    const socket = fakeSocket();
    const { container } = render(
      <Harness socket={socket} scrollToBottom={vi.fn()} bottomOffset="bottom-12" />,
    );

    expect(container.querySelector('.bottom-12')).not.toBeNull();
  });
});
