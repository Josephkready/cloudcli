import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { CreatedApiKey } from '../types';

import NewApiKeyAlert from './NewApiKeyAlert';

const apiKey: CreatedApiKey = {
  id: '1',
  keyName: 'New Key',
  apiKey: 'sk-brandnew',
};

describe('NewApiKeyAlert', () => {
  it('renders the created key and calls onCopy with the key and id "new"', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();

    render(<NewApiKeyAlert apiKey={apiKey} copiedKey={null} onCopy={onCopy} onDismiss={vi.fn()} />);

    expect(screen.getByText('sk-brandnew')).toBeInTheDocument();

    const buttons = screen.getAllByRole('button');
    await user.click(buttons[0]);
    expect(onCopy).toHaveBeenCalledWith('sk-brandnew', 'new');
  });

  it('shows a check icon when copiedKey is "new"', () => {
    render(<NewApiKeyAlert apiKey={apiKey} copiedKey="new" onCopy={vi.fn()} onDismiss={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons[0].querySelector('svg.lucide-check')).not.toBeNull();
  });

  it('calls onDismiss when the dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(<NewApiKeyAlert apiKey={apiKey} copiedKey={null} onCopy={vi.fn()} onDismiss={onDismiss} />);

    await user.click(screen.getByText(/saved it/i));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
