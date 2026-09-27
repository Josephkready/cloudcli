import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKeyItem } from '../types';

import ApiKeysSection from './ApiKeysSection';

const keys: ApiKeyItem[] = [
  {
    id: '1',
    key_name: 'My Key',
    api_key: 'sk-abc123',
    created_at: '2026-01-01T00:00:00.000Z',
    last_used: '2026-01-05T00:00:00.000Z',
    is_active: true,
  },
  {
    id: '2',
    key_name: 'Inactive Key',
    api_key: 'sk-xyz789',
    created_at: '2026-01-02T00:00:00.000Z',
    last_used: null,
    is_active: false,
  },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof ApiKeysSection>> = {}) {
  return {
    apiKeys: [],
    showNewKeyForm: false,
    newKeyName: '',
    onShowNewKeyFormChange: vi.fn(),
    onNewKeyNameChange: vi.fn(),
    onCreateApiKey: vi.fn(),
    onCancelCreateApiKey: vi.fn(),
    onToggleApiKey: vi.fn(),
    onDeleteApiKey: vi.fn(),
    ...overrides,
  };
}

describe('ApiKeysSection', () => {
  it('shows empty state when there are no keys', () => {
    render(<ApiKeysSection {...makeProps()} />);
    expect(screen.getByText(/no api keys/i)).toBeInTheDocument();
  });

  it('renders each key with created/last-used dates and status', () => {
    render(<ApiKeysSection {...makeProps({ apiKeys: keys })} />);

    expect(screen.getByText('My Key')).toBeInTheDocument();
    expect(screen.getByText('sk-abc123')).toBeInTheDocument();
    expect(screen.getByText('Inactive Key')).toBeInTheDocument();
    expect(screen.getAllByText(/active/i).length).toBeGreaterThan(0);
  });

  it('toggles the new-key form via the header button', async () => {
    const user = userEvent.setup();
    const onShowNewKeyFormChange = vi.fn();
    render(<ApiKeysSection {...makeProps({ onShowNewKeyFormChange })} />);

    await user.click(screen.getByRole('button', { name: /new/i }));
    expect(onShowNewKeyFormChange).toHaveBeenCalledWith(true);
  });

  it('renders the new key form and wires up create/cancel/name change', async () => {
    const user = userEvent.setup();
    const onNewKeyNameChange = vi.fn();
    const onCreateApiKey = vi.fn();
    const onCancelCreateApiKey = vi.fn();

    render(
      <ApiKeysSection
        {...makeProps({
          showNewKeyForm: true,
          newKeyName: 'test',
          onNewKeyNameChange,
          onCreateApiKey,
          onCancelCreateApiKey,
        })}
      />,
    );

    const input = screen.getByPlaceholderText(/key name|placeholder/i);
    await user.type(input, 'x');
    expect(onNewKeyNameChange).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /create/i }));
    expect(onCreateApiKey).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancelCreateApiKey).toHaveBeenCalledTimes(1);
  });

  it('calls onToggleApiKey and onDeleteApiKey for a key row', async () => {
    const user = userEvent.setup();
    const onToggleApiKey = vi.fn();
    const onDeleteApiKey = vi.fn();

    render(
      <ApiKeysSection
        {...makeProps({ apiKeys: [keys[0]], onToggleApiKey, onDeleteApiKey })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /active/i }));
    expect(onToggleApiKey).toHaveBeenCalledWith('1', true);

    const deleteButtons = screen.getAllByRole('button').filter((btn) => btn.querySelector('svg.lucide-trash2'));
    await user.click(deleteButtons[0]);
    expect(onDeleteApiKey).toHaveBeenCalledWith('1');
  });
});
