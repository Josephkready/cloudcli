import { useCallback, useState } from 'react';

type UseUnsavedChangesGuardParams = {
  isDirty: boolean;
  /** Resolves `false` when the write failed, in which case the editor stays open. */
  onSave: () => Promise<boolean> | boolean;
  onClose: () => void;
};

/**
 * Turns a close *request* into either a close or a Save/Discard/Cancel prompt.
 *
 * Esc used to close the editor unconditionally, so a single stray keypress
 * destroyed unsaved work with no confirmation — and the footer advertised that
 * discard path (`Esc to close`) right next to the save one (#231).
 */
export const useUnsavedChangesGuard = ({ isDirty, onSave, onClose }: UseUnsavedChangesGuardParams) => {
  const [isPromptOpen, setIsPromptOpen] = useState(false);

  const requestClose = useCallback(() => {
    if (!isDirty) {
      setIsPromptOpen(false);
      onClose();
      return;
    }

    setIsPromptOpen(true);
  }, [isDirty, onClose]);

  const cancel = useCallback(() => {
    setIsPromptOpen(false);
  }, []);

  const discard = useCallback(() => {
    setIsPromptOpen(false);
    onClose();
  }, [onClose]);

  const saveAndClose = useCallback(async () => {
    let saved = false;

    try {
      saved = await onSave();
    } catch {
      // Reported through `saved` staying false; the editor's own save-error
      // banner already carries the message.
      saved = false;
    }

    // A failed write must not close the editor — that would discard exactly the
    // work the user just asked to keep.
    if (!saved) {
      return;
    }

    setIsPromptOpen(false);
    onClose();
  }, [onClose, onSave]);

  return { isPromptOpen, requestClose, cancel, discard, saveAndClose };
};
