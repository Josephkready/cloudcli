import type { TFunction } from 'i18next';

/**
 * The prompt to show before a bulk archive-by-age runs, chosen from the
 * previewed count:
 *  - `inform`  — nothing qualifies (count === 0); tell the user, don't archive.
 *  - `confirm` — ask before archiving. When the count is known the copy names
 *                it (pluralized); when the preview failed (`archivableCount`
 *                is null) it falls back to the generic, count-less copy.
 *
 * Kept pure so the count→message branching is unit-testable without a DOM,
 * `window.confirm`, or the network round-trip that produced the count.
 */
export type BulkArchivePrompt =
  | { kind: 'inform'; message: string }
  | { kind: 'confirm'; message: string };

export function buildBulkArchivePrompt(
  archivableCount: number | null,
  olderThanDays: number,
  t: TFunction,
): BulkArchivePrompt {
  if (archivableCount === 0) {
    return {
      kind: 'inform',
      message: t('archive.bulkByAgeNoneIdle', {
        days: olderThanDays,
        defaultValue: 'No conversations have been idle for more than {{days}} days.',
      }),
    };
  }

  if (archivableCount === null) {
    return {
      kind: 'confirm',
      message: t('archive.bulkByAgeConfirm', {
        days: olderThanDays,
        defaultValue:
          'Archive all conversations with no activity in the last {{days}} days? You can restore them anytime from the archived view.',
      }),
    };
  }

  return {
    kind: 'confirm',
    message: t('archive.bulkByAgeConfirmCount', {
      count: archivableCount,
      days: olderThanDays,
      defaultValue:
        'Archive {{count}} conversations with no activity in the last {{days}} days? You can restore them anytime from the archived view.',
    }),
  };
}
