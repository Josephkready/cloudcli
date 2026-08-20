import { fireEvent, render, screen } from '@testing-library/react';
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
      antigravityModel="gemini-test"
      setAntigravityModel={vi.fn()}
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
        antigravity: {
          DEFAULT: 'gemini-test',
          OPTIONS: [{ value: 'gemini-test', label: 'Gemini Test' }],
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

describe('ProviderSelectionEmptyState search hint', () => {
  // #362: the hint names a keyboard shortcut, so on a touch device it advertised
  // a route the user cannot take — and it was the only pointer to search on the
  // screen. `matches` for '(pointer: coarse)' is the same signal the component
  // already used to keep the model picker from summoning the keyboard.
  const HINT = /to search sessions, files, and commits/;

  it('hides the keyboard shortcut hint on a coarse pointer', () => {
    mockPointer(true);
    renderPicker();

    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('still shows the hint on a fine pointer, where the shortcut works', () => {
    mockPointer(false);
    renderPicker();

    // Guards against "fixing" this by deleting the hint outright: the shortcut
    // is real and discoverable nowhere else on this screen.
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(screen.getByText(/^(Ctrl\+K|⌘K)$/)).toBeInTheDocument();
  });
});

describe('ProviderSelectionEmptyState — Antigravity models', () => {
  it('selects and persists an Antigravity model from the provider picker', () => {
    const setProvider = vi.fn();
    const setAntigravityModel = vi.fn();

    render(
      <ProviderSelectionEmptyState
        selectedSession={null}
        currentSessionId={null}
        provider="claude"
        setProvider={setProvider}
        textareaRef={{ current: null }}
        claudeModel="sonnet"
        setClaudeModel={vi.fn()}
        codexModel="gpt-test"
        setCodexModel={vi.fn()}
        antigravityModel="gemini-test"
        setAntigravityModel={setAntigravityModel}
        providerModelCatalog={{
          claude: {
            DEFAULT: 'sonnet',
            OPTIONS: [{ value: 'sonnet', label: 'Sonnet' }],
          },
          codex: {
            DEFAULT: 'gpt-test',
            OPTIONS: [{ value: 'gpt-test', label: 'GPT Test' }],
          },
          antigravity: {
            DEFAULT: 'gemini-test',
            OPTIONS: [
              { value: 'gemini-test', label: 'Gemini Test' },
              { value: 'gemini-alt', label: 'Gemini Alt' },
            ],
          },
        }}
        providerModelsLoading={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Claude.*Sonnet/i }));
    fireEvent.click(screen.getByText('Gemini Alt'));

    expect(setProvider).toHaveBeenCalledWith('antigravity');
    expect(setAntigravityModel).toHaveBeenCalledWith('gemini-alt');
    expect(localStorage.getItem('selected-provider')).toBe('antigravity');
    expect(localStorage.getItem('antigravity-model')).toBe('gemini-alt');
  });
});
