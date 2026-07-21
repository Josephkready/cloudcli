import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../types/types';

import MessageComponent from './MessageComponent';

/*
 * Regression lock for #39: a tagged local-command user turn (`isLocalCommand`)
 * renders as a compact command chip (Terminal icon + monospace label), not a
 * prose bubble — and it falls back to the normal bubble when the command label
 * is empty. `formatLocalCommandLabel` and the content filter are tested
 * elsewhere; this closes the untested render link.
 */

function renderMessage(message: Partial<ChatMessage>) {
  const full = {
    type: 'user',
    timestamp: '2026-07-21T10:00:00.000Z',
    ...message,
  } as ChatMessage;

  return render(
    <MessageComponent
      message={full}
      prevMessage={null}
      createDiff={() => []}
      provider="claude"
    />,
  );
}

describe('MessageComponent — local-command chip (#39)', () => {
  it('renders a tagged local command as a monospace chip with a Terminal icon', () => {
    const { container } = renderMessage({
      type: 'user',
      isLocalCommand: true,
      commandName: 'usage',
      content: '/usage',
    });

    const label = screen.getByText('/usage');
    // Chip, not prose: the label is monospace and carries a title tooltip.
    expect(label).toHaveClass('font-mono');
    expect(label).toHaveAttribute('title', '/usage');
    // The Terminal glyph lives inside the chip container next to the label.
    expect(label.parentElement?.querySelector('svg')).not.toBeNull();
    // No prose user bubble was rendered (the bubble is the only element with
    // the `rounded-br-md` tail).
    expect(container.querySelector('.rounded-br-md')).toBeNull();
  });

  it('appends command args to the chip label', () => {
    renderMessage({
      type: 'user',
      isLocalCommand: true,
      commandName: 'model',
      commandArgs: 'opus',
      content: '/model opus',
    });

    expect(screen.getByText('/model opus')).toHaveClass('font-mono');
  });

  it('falls back to the normal prose bubble when the command label is empty', () => {
    const { container } = renderMessage({
      type: 'user',
      isLocalCommand: true,
      content: '',
    });

    // No chip: nothing is rendered monospace.
    expect(container.querySelector('.font-mono')).toBeNull();
    // The normal (empty) user bubble is rendered instead.
    expect(container.querySelector('.rounded-br-md')).not.toBeNull();
  });

  it('does not chip an ordinary message that merely starts with a slash', () => {
    const { container } = renderMessage({
      type: 'user',
      isLocalCommand: false,
      content: '/usage is a slash but not a tagged command',
    });

    const bubble = screen.getByText('/usage is a slash but not a tagged command');
    // Rendered as prose (font-serif bubble), never as a monospace chip.
    expect(bubble).toHaveClass('font-serif');
    expect(bubble).not.toHaveClass('font-mono');
    expect(container.querySelector('.font-mono')).toBeNull();
    expect(container.querySelector('.rounded-br-md')).not.toBeNull();
  });
});
