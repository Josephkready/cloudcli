import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';

function mockPointer(coarse: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === '(pointer: coarse)' && coarse,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

function renderPicker() {
  render(
    <ProviderSelectionEmptyState
      selectedSession={null}
      currentSessionId={null}
      provider="claude"
      setProvider={vi.fn()}
      textareaRef={createRef<HTMLTextAreaElement>()}
      claudeModel="default"
      setClaudeModel={vi.fn()}
      codexModel="gpt-5.6-sol"
      setCodexModel={vi.fn()}
      providerModelCatalog={{
        claude: {
          DEFAULT: 'default',
          OPTIONS: [
            { value: 'default', label: 'Default' },
            { value: 'opus', label: 'Opus' },
          ],
        },
        codex: {
          DEFAULT: 'gpt-5.6-sol',
          OPTIONS: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }],
        },
      }}
      providerModelsLoading={false}
    />,
  );
}

async function openPicker() {
  const user = userEvent.setup();
  const hint = screen.getByText('Click to change model');
  await user.click(hint.closest('[role="button"]') as HTMLElement);
}

describe('ProviderSelectionEmptyState mobile model picker', () => {
  it('keeps focus off search on a coarse pointer so opening does not summon the keyboard', async () => {
    mockPointer(true);
    renderPicker();

    await openPicker();

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    expect(screen.getByPlaceholderText('Search models...')).not.toHaveFocus();
  });

  it('preserves search-first keyboard behavior for fine pointers', async () => {
    mockPointer(false);
    renderPicker();

    await openPicker();

    expect(screen.getByPlaceholderText('Search models...')).toHaveFocus();
  });

  it('uses a viewport-bound bottom sheet with one flexible scroll list', async () => {
    mockPointer(true);
    renderPicker();

    await openPicker();

    expect(screen.getByRole('dialog')).toHaveClass(
      'bottom-0',
      'max-h-[85dvh]',
      'rounded-t-2xl',
      'sm:top-1/2',
    );
    expect(screen.getByRole('listbox')).toHaveClass(
      'min-h-0',
      'max-h-none',
      'flex-1',
      'overscroll-contain',
    );
  });
});
