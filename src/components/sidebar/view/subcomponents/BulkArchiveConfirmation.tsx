import type { TFunction } from 'i18next';
import React from 'react';

import type { BulkArchivePrompt } from '../../utils/bulkArchivePrompt';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationTitle,
} from '../../../../shared/view/ui/Confirmation';

export interface BulkArchiveConfirmationProps {
  // The active prompt, or null when the dialog is closed.
  prompt: BulkArchivePrompt | null;
  // Run the archive (only reachable from a `confirm` prompt).
  onConfirm: () => void;
  // Dismiss without archiving — Cancel on `confirm`, or OK on `inform`.
  onCancel: () => void;
  t: TFunction;
}

/**
 * Inline confirmation banner shown before a bulk archive-by-age runs, replacing
 * the blocking `window.confirm` / `window.alert`. Built on the shared
 * `Confirmation` primitive so it matches the chat permission banner and renders
 * inline (statically render-testable, unlike the sidebar's portal delete
 * modals). Renders nothing when there is no active prompt.
 *
 * A `confirm` prompt offers Cancel + Archive; an `inform` prompt (nothing
 * qualifies) offers a single OK that just dismisses.
 */
export function BulkArchiveConfirmation({
  prompt,
  onConfirm,
  onCancel,
  t,
}: BulkArchiveConfirmationProps) {
  if (!prompt) {
    return null;
  }

  return (
    <Confirmation approval="pending" role="alert" aria-label={prompt.message} className="m-2">
      <ConfirmationTitle>{prompt.message}</ConfirmationTitle>
      <ConfirmationActions>
        {prompt.kind === 'confirm' ? (
          <>
            <ConfirmationAction variant="outline" onClick={onCancel}>
              {t('archive.bulkByAgeCancelAction', 'Cancel')}
            </ConfirmationAction>
            <ConfirmationAction variant="destructive" onClick={onConfirm}>
              {t('archive.bulkByAgeConfirmAction', 'Archive')}
            </ConfirmationAction>
          </>
        ) : (
          <ConfirmationAction variant="default" onClick={onCancel}>
            {t('archive.bulkByAgeDismissAction', 'OK')}
          </ConfirmationAction>
        )}
      </ConfirmationActions>
    </Confirmation>
  );
}

export default BulkArchiveConfirmation;
