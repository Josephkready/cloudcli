import { AlertTriangle } from 'lucide-react';

import { disabledControlClasses } from '../../../../shared/view/ui/disabledState';

type CodeEditorUnsavedChangesPromptProps = {
  fileName: string;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  labels: {
    title: string;
    message: string;
    save: string;
    saving: string;
    discard: string;
    cancel: string;
  };
};

/**
 * Shown when the user asks to close an editor with unsaved edits (#231). Before
 * this, Esc closed instantly and the edit was unrecoverable.
 */
export default function CodeEditorUnsavedChangesPrompt({
  fileName,
  saving,
  onSave,
  onDiscard,
  onCancel,
  labels,
}: CodeEditorUnsavedChangesPromptProps) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={labels.title}
        className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-xl"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-foreground">{labels.title}</h4>
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {labels.message.replace('{{fileName}}', fileName)}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {labels.cancel}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-md px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            {labels.discard}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            autoFocus
            className={`rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 ${disabledControlClasses}`}
          >
            {saving ? labels.saving : labels.save}
          </button>
        </div>
      </div>
    </div>
  );
}
