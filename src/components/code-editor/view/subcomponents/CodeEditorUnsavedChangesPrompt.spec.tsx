import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import CodeEditorUnsavedChangesPrompt from './CodeEditorUnsavedChangesPrompt';

/*
 * #231: closing a dirty editor destroyed the work with no confirmation. This is
 * the Save / Discard / Cancel prompt that now stands in the way.
 */

const labels = {
  title: 'Unsaved changes',
  message: 'You have unsaved changes in {{fileName}}.',
  save: 'Save',
  saving: 'Saving...',
  discard: 'Discard',
  cancel: 'Cancel',
};

function renderPrompt(overrides: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  const onCancel = vi.fn();
  const result = render(
    <CodeEditorUnsavedChangesPrompt
      fileName="README.md"
      saving={false}
      onSave={onSave}
      onDiscard={onDiscard}
      onCancel={onCancel}
      labels={labels}
      {...overrides}
    />,
  );
  return { ...result, onSave, onDiscard, onCancel };
}

describe('CodeEditorUnsavedChangesPrompt (#231)', () => {
  it('names the file at risk', () => {
    renderPrompt();

    expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    expect(screen.getByText('You have unsaved changes in README.md.')).toBeInTheDocument();
  });

  it('wires each of the three choices to its own callback', async () => {
    const user = userEvent.setup();
    const { onSave, onDiscard, onCancel } = renderPrompt();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables Save while a write is in flight', () => {
    renderPrompt({ saving: true });

    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });
});
