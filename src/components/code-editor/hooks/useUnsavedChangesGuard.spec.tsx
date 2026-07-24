import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

/*
 * #231: Esc closed the editor unconditionally and the edit was unrecoverable —
 * no confirmation, and nothing had ever indicated the buffer was dirty. This
 * guard is what turns a close *request* into either a close or a prompt.
 */

type Guard = ReturnType<typeof useUnsavedChangesGuard>;

let guard: Guard;

type SaveResult = Promise<boolean> | boolean;

function Harness({
  isDirty,
  onSave,
  onClose,
}: {
  isDirty: boolean;
  onSave: () => SaveResult;
  onClose: () => void;
}) {
  guard = useUnsavedChangesGuard({ isDirty, onSave, onClose });
  return null;
}

function setup(isDirty: boolean, onSaveImpl?: () => SaveResult) {
  const onClose = vi.fn();
  const onSave = vi.fn<() => SaveResult>(onSaveImpl ?? (() => true));
  const result = render(<Harness isDirty={isDirty} onSave={onSave} onClose={onClose} />);
  return { ...result, onClose, onSave };
}

describe('useUnsavedChangesGuard (#231)', () => {
  it('closes straight away when the buffer is clean', () => {
    const { onClose } = setup(false);

    act(() => guard.requestClose());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(guard.isPromptOpen).toBe(false);
  });

  it('prompts instead of closing when the buffer is dirty', () => {
    const { onClose } = setup(true);

    act(() => guard.requestClose());

    expect(onClose).not.toHaveBeenCalled();
    expect(guard.isPromptOpen).toBe(true);
  });

  it('cancel dismisses the prompt and keeps the editor open', () => {
    const { onClose } = setup(true);

    act(() => guard.requestClose());
    act(() => guard.cancel());

    expect(guard.isPromptOpen).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('discard closes without saving', () => {
    const { onClose, onSave } = setup(true);

    act(() => guard.requestClose());
    act(() => guard.discard());

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(guard.isPromptOpen).toBe(false);
  });

  it('save writes the file and only then closes', async () => {
    let resolveSave: (saved: boolean) => void = () => {};
    const savePromise = new Promise<boolean>((resolve) => {
      resolveSave = resolve;
    });
    const { onClose, onSave } = setup(true, () => savePromise);

    act(() => guard.requestClose());
    let saveAndClose!: Promise<void>;
    act(() => {
      saveAndClose = guard.saveAndClose();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    // Still open while the write is in flight.
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave(true);
      await saveAndClose;
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the editor open when the save reports failure, so the work is not lost', async () => {
    const { onClose } = setup(true, () => false);

    act(() => guard.requestClose());
    await act(async () => {
      await guard.saveAndClose();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(guard.isPromptOpen).toBe(true);
  });

  it('also survives a save that throws outright', async () => {
    const { onClose } = setup(true, () => Promise.reject(new Error('disk full')));

    act(() => guard.requestClose());
    await act(async () => {
      await guard.saveAndClose();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(guard.isPromptOpen).toBe(true);
  });
});
