import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';

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
