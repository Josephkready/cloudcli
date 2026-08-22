import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bug, CheckCircle2, ExternalLink, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle, disabledBusyControlClasses } from '../../shared/view/ui';
import { useVersionCheck } from '../../hooks/useVersionCheck';
import { api } from '../../utils/api';
import { recordFeatureUse } from '../../utils/featureUsage';
import type { AppTab, Project, ProjectSession } from '../../types/app';

import {
  buildBugReportMetadata,
  readBrowserEnvironment,
  type BrowserEnvironment,
  type BugReportMetadata,
} from './buildBugReportMetadata';

/** Mirrors the server's `MAX_DESCRIPTION_LENGTH`, so the UI blocks what the API would reject. */
const MAX_DESCRIPTION_LENGTH = 20000;

/** Long enough to rule out an accidental submit, short enough not to nag. */
const MIN_DESCRIPTION_LENGTH = 10;

type BugReportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTab: AppTab;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  /**
   * Environment sampled by whoever summoned the reporter, at the moment they
   * summoned it. Preferred over reading it here — see the snapshot comment below.
   */
  capturedEnvironment?: BrowserEnvironment | null;
};

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'submitted'; issueUrl: string }
  | { status: 'error'; message: string };

/** One metadata row in the "what gets sent" disclosure. */
function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-baseline justify-between gap-3 py-1"
      data-testid="bug-report-metadata-row"
      data-metadata-key={label}
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-[11px] text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

/**
 * Bug reporter opened from the top panel.
 *
 * The user writes what went wrong; the session metadata is collected for them
 * and shown up front (nothing is sent that they can't see first), and the server
 * files it as a GitHub issue.
 */
export default function BugReportDialog({
  open,
  onOpenChange,
  activeTab,
  selectedProject,
  selectedSession,
  capturedEnvironment,
}: BugReportDialogProps) {
  const { t } = useTranslation();
  const { currentVersion, runningVersion } = useVersionCheck();
  const [description, setDescription] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle' });
  const [showMetadata, setShowMetadata] = useState(false);

  // Prefer the caller's snapshot; only read the environment here if there isn't
  // one.
  //
  // Open time is too late for anything the keyboard touches. Summoning this
  // dialog means pressing something, pressing something blurs the focused field,
  // and a blurred field on iOS takes the keyboard — and the shrunken visual
  // viewport — with it. Reading here recorded `keyboardInset: 0px` on every
  // report ever filed, which is the exact signature of "the app never noticed
  // the keyboard" and made #358's new rows unable to diagnose #354, the bug they
  // were added for. `MainContentHeader` now samples on `pointerdown`, before the
  // focus change.
  //
  // The fallback is still correct for any caller that opens the dialog without a
  // press to hang a snapshot on; there is no keyboard to lose in that case.
  const metadata = useMemo<BugReportMetadata>(() => {
    if (!open) return {};
    return buildBugReportMetadata({
      appVersion: currentVersion,
      serverVersion: runningVersion,
      activeTab,
      project: selectedProject,
      session: selectedSession,
      environment: capturedEnvironment ?? readBrowserEnvironment(),
    });
    // `open` is the intended trigger for re-snapshotting.
  }, [
    open,
    currentVersion,
    runningVersion,
    activeTab,
    selectedProject,
    selectedSession,
    capturedEnvironment,
  ]);

  // Reset between openings so a previous success or error never greets the next report.
  useEffect(() => {
    if (open) return;
    setDescription('');
    setSubmitState({ status: 'idle' });
    setShowMetadata(false);
  }, [open]);

  const trimmedLength = description.trim().length;
  const canSubmit =
    trimmedLength >= MIN_DESCRIPTION_LENGTH &&
    description.length <= MAX_DESCRIPTION_LENGTH &&
    submitState.status !== 'submitting';

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    setSubmitState({ status: 'submitting' });
    try {
      const response = await api.createBugReport({ description: description.trim(), metadata });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setSubmitState({
          status: 'error',
          message: payload?.error?.message || payload?.error || t('bugReport.genericError'),
        });
        return;
      }

      const issueUrl = payload?.data?.issueUrl;
      if (typeof issueUrl !== 'string') {
        setSubmitState({ status: 'error', message: t('bugReport.genericError') });
        return;
      }

      recordFeatureUse('bug_report.submit');
      setSubmitState({ status: 'submitted', issueUrl });
    } catch {
      setSubmitState({ status: 'error', message: t('bugReport.networkError') });
    }
  }, [canSubmit, description, metadata, t]);

  const metadataEntries = Object.entries(metadata);
  const isSubmitting = submitState.status === 'submitting';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(92dvh,44rem)] w-[calc(100vw-1rem)] max-w-xl flex-col overflow-hidden rounded-3xl border-border/80 bg-popover/95 p-0 shadow-2xl">
        <DialogTitle>{t('bugReport.title')}</DialogTitle>

        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-popover px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-foreground">
              <Bug className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-lg font-semibold tracking-tight text-foreground">{t('bugReport.title')}</p>
              <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{t('bugReport.subtitle')}</p>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('bugReport.close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {submitState.status === 'submitted' ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-500" />
              <p className="text-base font-semibold text-foreground">{t('bugReport.successTitle')}</p>
              <p className="max-w-sm text-sm text-muted-foreground">{t('bugReport.successBody')}</p>
              <a
                href={submitState.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-background px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
              >
                {t('bugReport.viewIssue')}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="bug-report-description" className="text-sm font-medium text-foreground">
                  {t('bugReport.descriptionLabel')}
                </label>
                <textarea
                  id="bug-report-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={MAX_DESCRIPTION_LENGTH}
                  rows={9}
                  autoFocus
                  disabled={isSubmitting}
                  placeholder={t('bugReport.descriptionPlaceholder')}
                  className={`w-full resize-y rounded-xl border border-border/70 bg-background px-3 py-2.5 text-sm leading-6 text-foreground shadow-none outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/30 ${disabledBusyControlClasses}`}
                />
                <p className="text-xs text-muted-foreground">{t('bugReport.descriptionHint')}</p>
              </div>

              {metadataEntries.length > 0 && (
                <div className="rounded-xl border border-border/70 bg-muted/20">
                  <button
                    type="button"
                    onClick={() => setShowMetadata((previous) => !previous)}
                    aria-expanded={showMetadata}
                    className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-sm font-medium text-foreground"
                  >
                    <span>{t('bugReport.metadataToggle', { count: metadataEntries.length })}</span>
                    <span className="text-xs text-muted-foreground">
                      {showMetadata ? t('bugReport.hide') : t('bugReport.show')}
                    </span>
                  </button>
                  {showMetadata && (
                    <div className="border-t border-border/60 px-3.5 py-2 text-xs">
                      {metadataEntries.map(([key, value]) => (
                        <MetadataRow key={key} label={key} value={String(value)} />
                      ))}
                    </div>
                  )}
                </div>
              )}

            </div>
          )}
        </div>

        {/* The failure notice lives outside the scroll area: a long report plus
            the expanded metadata pushes anything appended below the fold, where
            the reporter would never see why filing failed. */}
        {submitState.status === 'error' && (
          <p
            role="alert"
            className="mx-4 mb-3 shrink-0 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive sm:mx-6"
          >
            {submitState.message}
          </p>
        )}

        {submitState.status !== 'submitted' && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/70 bg-muted/20 px-4 py-3 sm:px-6">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} className="rounded-xl">
              {t('bugReport.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="rounded-xl"
            >
              {isSubmitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {isSubmitting ? t('bugReport.submitting') : t('bugReport.submit')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
