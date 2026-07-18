import { useTranslation } from 'react-i18next';

import { ErrorResultContent } from './ErrorResultContent';
import MessageCopyControl from './MessageCopyControl';

interface ErrorToolResultProps {
  content: string;
  toolId?: string;
}

/**
 * Red error box for a failed tool result (`message.toolResult.isError`).
 *
 * The header pins the "Error" label plus a copy control (#151) so the control
 * stays visible while the capped (`max-h-80`, #58) preformatted body (#145)
 * scrolls. The copy control only appears when there is content worth copying.
 *
 * Split out of MessageComponent so this gate is unit-testable via
 * `renderToStaticMarkup` without importing MessageComponent's Markdown /
 * syntax-highlighter chain (which the bare test runner can't resolve).
 */
export function ErrorToolResult({ content, toolId }: ErrorToolResultProps) {
  const { t } = useTranslation('chat');
  const hasContent = content.trim().length > 0;

  return (
    <div
      id={`tool-result-${toolId}`}
      className="relative mt-2 scroll-mt-4 rounded border border-red-200/60 bg-red-50/50 p-3 dark:border-red-800/40 dark:bg-red-950/10"
    >
      <div className="relative mb-2 flex items-center gap-1.5">
        <svg className="h-4 w-4 text-red-500 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
        <span className="text-xs font-medium text-red-700 dark:text-red-300">{t('messageTypes.error')}</span>
        {/* Copy control pinned in the header row so it stays visible while the
            (max-h-80) error body scrolls (#151). Copies the raw stderr/
            stack-trace verbatim as plain text. */}
        {hasContent && (
          <div className="ml-auto flex-shrink-0">
            <MessageCopyControl content={content} messageType="error" />
          </div>
        )}
      </div>
      {/* Cap the error body so a long stderr/stack-trace dump can't dominate the
          chat (#58); the "Error" header above stays pinned and the body scrolls,
          mirroring Bash's auto-expand-on-error max-h-80. Error/stderr is
          preformatted monospace, not prose Markdown (#145). */}
      <div className="relative max-h-80 overflow-y-auto text-sm text-red-900 dark:text-red-100">
        <ErrorResultContent content={content} />
      </div>
    </div>
  );
}
