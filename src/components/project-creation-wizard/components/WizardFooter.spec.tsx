import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import WizardFooter from './WizardFooter';
import type { WizardStep } from '../types';

function renderFooter(overrides: Partial<Parameters<typeof WizardFooter>[0]> = {}) {
  const onClose = vi.fn();
  const onBack = vi.fn();
  const onNext = vi.fn();
  const onCreate = vi.fn();

  const props = {
    step: 1 as WizardStep,
    isCreating: false,
    isCloneWorkflow: false,
    onClose,
    onBack,
    onNext,
    onCreate,
    ...overrides,
  };

  const result = render(<WizardFooter {...props} />);
  return { ...result, onClose, onBack, onNext, onCreate };
}

describe('WizardFooter', () => {
  it('shows Cancel and Next on step 1, and Cancel calls onClose', async () => {
    const user = userEvent.setup();
    const { onClose, onBack } = renderFooter({ step: 1 });

    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('clicking Next on step 1 calls onNext', async () => {
    const user = userEvent.setup();
    const { onNext, onCreate } = renderFooter({ step: 1 });

    await user.click(screen.getByRole('button', { name: /next/i }));

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('shows Back and Create Project on step 2, and Back calls onBack', async () => {
    const user = userEvent.setup();
    const { onBack, onClose } = renderFooter({ step: 2 });

    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create project/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking Create Project on step 2 calls onCreate', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderFooter({ step: 2 });

    await user.click(screen.getByRole('button', { name: /create project/i }));

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('shows "Creating..." and disables both buttons while isCreating and not a clone', () => {
    renderFooter({ step: 2, isCreating: true, isCloneWorkflow: false });

    expect(screen.getByText('Creating...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled();
  });

  it('shows "Cloning..." while isCreating and isCloneWorkflow', () => {
    renderFooter({ step: 2, isCreating: true, isCloneWorkflow: true });

    expect(screen.getByText('Cloning...')).toBeInTheDocument();
  });
});
