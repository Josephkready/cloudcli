import { useEffect } from 'react';

type UseEditorKeyboardShortcutsParams = {
  onSave: () => void;
  onClose: () => void;
  dependency: string;
};

export const useEditorKeyboardShortcuts = ({
  onSave,
  onClose,
  dependency,
}: UseEditorKeyboardShortcutsParams) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // The listener is on `document` so the editor responds wherever focus
      // happens to be, which also means every other component's Escape passed
      // through here. Anything that already consumed the key owns it — before,
      // this branch preventDefault'd unconditionally and closed the editor in
      // response to an Escape meant for a popover or a search box (#231).
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dependency, onClose, onSave]);
};
