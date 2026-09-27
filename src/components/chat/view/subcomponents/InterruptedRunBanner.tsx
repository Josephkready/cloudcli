import { RotateCcwIcon } from 'lucide-react';

/**
 * Small banner shown above the composer when a session's in-flight or queued
 * work was stranded by a server restart (issue #70). Offers a one-click resume
 * so the user's message is never silently lost — worst case it is surfaced here
 * as interrupted and resumable.
 *
 * Kept as a pure presentational component (visibility gated by the caller via
 * `shouldOfferResume`, labels injected for i18n) so it renders in isolation and
 * is unit-testable without the full chat/websocket/i18n stack.
 */
type InterruptedRunBannerProps = {
  show: boolean;
  onResume: () => void;
  message?: string;
  resumeLabel?: string;
};

export function InterruptedRunBanner({
  show,
  onResume,
  message = 'This run was interrupted by a server restart.',
  resumeLabel = 'Resume',
}: InterruptedRunBannerProps) {
  if (!show) {
    return null;
  }

  return (
    <div
      role="status"
      className="mx-auto mb-2 flex w-full max-w-3xl items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onResume}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/50 bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
      >
        <RotateCcwIcon className="h-3.5 w-3.5" aria-hidden />
        {resumeLabel}
      </button>
    </div>
  );
}
