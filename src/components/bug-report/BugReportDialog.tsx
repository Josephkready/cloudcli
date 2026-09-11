import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bug, CheckCircle2, ExternalLink, Loader2, Paperclip, X } from 'lucide-react';
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
import {
  canAcceptMore,
  extractImageEntries,
  privacyNotice,
  rejectionMessage,
  removeStaged,
  stageResult,
  type StagedAttachment,
} from './attachments';
import { compressImage } from './compressImage';

/** Mirrors the server's `MAX_DESCRIPTION_LENGTH`, so the UI blocks what the API would reject. */
const MAX_DESCRIPTION_LENGTH = 20000;

/** Long enough to rule out an accidental submit, short enough not to nag. */
const MIN_DESCRIPTION_LENGTH = 10;

/** Presentation polling only; the worker continues after this dialog stops asking. */
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30;

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
  | { status: 'queued'; jobId: string }
  | { status: 'submitted'; issueUrl: string }
  | { status: 'delayed' }
  | { status: 'savedError'; message: string }
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
 * and shown up front (nothing is sent that they can't see first). The server
 * durably queues it, then this dialog polls for the final GitHub link.
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

  // Screenshots (dante-config skills/bug-report-button/SKILL.md §9): staged,
  // previewed, and compressed client-side, but never persisted anywhere — a
  // compressed blob is too large to keep around the way the typed draft is,
  // and this dialog has no durable draft store to put binary content in
  // regardless. Session-only for exactly as long as this dialog is open.
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const [attachmentHint, setAttachmentHint] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Every `URL.createObjectURL()` preview must be revoked exactly once: on
  // removal, on a confirmed send, and here — whenever the tray this ref
  // tracks is about to be replaced or the dialog unmounts with images still
  // staged. Kept in a ref (not derived from state) so the unmount cleanup
  // below always sees the latest tray without re-subscribing on every stage.
  const stagedAttachmentsRef = useRef<StagedAttachment[]>([]);
  useEffect(() => {
    stagedAttachmentsRef.current = stagedAttachments;
  }, [stagedAttachments]);
  useEffect(() => () => {
    for (const attachment of stagedAttachmentsRef.current) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

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
    setAttachmentHint('');
    // Screenshots are session-only (see the note above `stagedAttachments`) —
    // closing the dialog without sending drops them, same as a hard reload
    // would, and every preview URL for them must be revoked right here.
    for (const attachment of stagedAttachmentsRef.current) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    setStagedAttachments([]);
  }, [open]);

  useEffect(() => {
    if (submitState.status !== 'queued') return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const jobId = submitState.jobId;

    const stopWithStatusError = (message: string) => {
      if (!cancelled) setSubmitState({ status: 'savedError', message });
    };

    const poll = async () => {
      attempts += 1;
      try {
        const response = await api.getBugReportStatus(jobId);
        const payload = await response.json().catch(() => null);
        if (cancelled) return;

        if (!response.ok) {
          stopWithStatusError(
            payload?.error?.message || payload?.error || t('bugReport.statusUnavailable'),
          );
          return;
        }

        const status = payload?.data?.status;
        if (status === 'filed') {
          const issueUrl = payload?.data?.url;
          if (typeof issueUrl === 'string') {
            setSubmitState({ status: 'submitted', issueUrl });
          } else {
            stopWithStatusError(t('bugReport.statusUnavailable'));
          }
          return;
        }
        if (status === 'failed') {
          stopWithStatusError(payload?.data?.detail || t('bugReport.filingNeedsAttention'));
          return;
        }
      } catch {
        // A transient browser/network failure says nothing about the durable worker. Retry below.
      }

      if (attempts >= MAX_POLL_ATTEMPTS) {
        setSubmitState({ status: 'delayed' });
        return;
      }
      timer = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [submitState, t]);

  /**
   * The single entry point for every WIRED capture path — the file input and
   * the textarea's `paste` listener below (drag-and-drop is optional per the
   * standard and not wired here; `extractImageEntries` already accepts a
   * `DataTransfer`-shaped source, so adding a `drop` listener later is a
   * small addition, not a redesign). Compresses each file in turn and stages
   * what's accepted, surfacing exactly one rejection reason at a time so a
   * batch that's mostly fine doesn't get buried under repeated hints.
   */
  const stageFiles = useCallback(async (files: Array<{ name?: string; type?: string }>) => {
    let lastRejection: string | null = null;
    for (const file of files) {
      if (!canAcceptMore(stagedAttachmentsRef.current)) {
        lastRejection = 'too-many';
        break;
      }
      let compressed;
      try {
        compressed = await compressImage(file as File);
      } catch (error) {
        setAttachmentHint(error instanceof Error && error.message ? error.message : rejectionMessage('unsupported'));
        continue;
      }
      const previewUrl = URL.createObjectURL(compressed.blob);
      const { list, rejected } = stageResult(stagedAttachmentsRef.current, { ...compressed, previewUrl });
      if (rejected) {
        URL.revokeObjectURL(previewUrl);
        lastRejection = rejected;
        continue;
      }
      stagedAttachmentsRef.current = list;
      setStagedAttachments(list);
    }
    if (lastRejection) setAttachmentHint(rejectionMessage(lastRejection));
  }, []);

  // File picker: `capture="environment"` (set in the markup) offers the rear
  // camera on a phone without removing the picker. The input is cleared after
  // every change so selecting the SAME file twice in a row still fires a
  // `change` event (which only fires on an actual value change otherwise).
  const handleFileInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = extractImageEntries(event.target.files);
    event.target.value = '';
    if (files.length) void stageFiles(files);
  }, [stageFiles]);

  // Clipboard paste: never intercepted or blocked. A paste that carries both
  // a screenshot and typed text must still let the text land in the textarea
  // via the browser's own default behavior — this only ever ADDS staged
  // images alongside whatever the paste does normally.
  const handleDescriptionPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = extractImageEntries(event.clipboardData);
    if (files.length) void stageFiles(files);
  }, [stageFiles]);

  const handleRemoveAttachment = useCallback((id: string) => {
    const target = stagedAttachmentsRef.current.find((attachment) => attachment.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    const next = removeStaged(stagedAttachmentsRef.current, id);
    stagedAttachmentsRef.current = next;
    setStagedAttachments(next);
  }, []);

  const trimmedLength = description.trim().length;
  const canSubmit =
    trimmedLength >= MIN_DESCRIPTION_LENGTH &&
    description.length <= MAX_DESCRIPTION_LENGTH &&
    submitState.status !== 'submitting';

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    setSubmitState({ status: 'submitting' });
    try {
      const attachments = stagedAttachments.map((attachment) => ({
        name: attachment.name,
        blob: attachment.blob,
      }));
      const response = await api.createBugReport({ description: description.trim(), metadata, attachments });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setSubmitState({
          status: 'error',
          message: payload?.error?.message || payload?.error || t('bugReport.genericError'),
        });
        return;
      }

      const jobId = payload?.data?.id;
      if (payload?.data?.status !== 'queued' || typeof jobId !== 'string') {
        setSubmitState({ status: 'error', message: t('bugReport.genericError') });
        return;
      }

      // This attempt's request already carried these bytes — revoke every
      // preview now, matching the draft's own clear-on-confirmed-enqueue
      // behavior. Left staged (not cleared) on any error path above, so a
      // retried "File issue" click doesn't ask the reporter to reattach.
      for (const attachment of stagedAttachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      stagedAttachmentsRef.current = [];
      setStagedAttachments([]);

      recordFeatureUse('bug_report.submit');
      setSubmitState({ status: 'queued', jobId });
    } catch {
      setSubmitState({ status: 'error', message: t('bugReport.networkError') });
    }
  }, [canSubmit, description, metadata, stagedAttachments, t]);

  const metadataEntries = Object.entries(metadata);
  const isSubmitting = submitState.status === 'submitting';
  const showsForm = submitState.status === 'idle' || isSubmitting || submitState.status === 'error';

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
          ) : submitState.status === 'queued' ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center" role="status">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="text-base font-semibold text-foreground">{t('bugReport.queuedTitle')}</p>
              <p className="max-w-sm text-sm text-muted-foreground">{t('bugReport.queuedBody')}</p>
            </div>
          ) : submitState.status === 'delayed' ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center" role="status">
              <CheckCircle2 className="h-10 w-10 text-emerald-500" />
              <p className="text-base font-semibold text-foreground">{t('bugReport.delayedTitle')}</p>
              <p className="max-w-sm text-sm text-muted-foreground">{t('bugReport.delayedBody')}</p>
            </div>
          ) : submitState.status === 'savedError' ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center" role="alert">
              <AlertTriangle className="h-10 w-10 text-amber-500" />
              <p className="text-base font-semibold text-foreground">{t('bugReport.savedErrorTitle')}</p>
              <p className="max-w-sm text-sm text-muted-foreground">{submitState.message}</p>
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
                  onPaste={handleDescriptionPaste}
                  maxLength={MAX_DESCRIPTION_LENGTH}
                  rows={9}
                  autoFocus
                  disabled={isSubmitting}
                  placeholder={t('bugReport.descriptionPlaceholder')}
                  className={`w-full resize-y rounded-xl border border-border/70 bg-background px-3 py-2.5 text-sm leading-6 text-foreground shadow-none outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/30 ${disabledBusyControlClasses}`}
                />
                <p className="text-xs text-muted-foreground">{t('bugReport.descriptionHint')}</p>
              </div>

              {/* Screenshots (dante-config skills/bug-report-button/SKILL.md
                  §9): explicit and user-initiated only — a file picker
                  (`capture="environment"` offers the camera on a phone
                  without removing the picker) plus clipboard paste on the
                  textarea above, wired via `stageFiles`. Never an automatic
                  snapshot. Excluded entirely from the metadata disclosure
                  above: screenshots are binary user-attached content, not
                  allowlisted/sanitized context. */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isSubmitting || !canAcceptMore(stagedAttachments)}
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-xl"
                  >
                    <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                    {t('bugReport.attachScreenshot')}
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    hidden
                    data-testid="bug-report-file-input"
                    onChange={handleFileInputChange}
                  />
                  {attachmentHint && (
                    <span className="flex-1 text-xs text-muted-foreground" aria-live="polite">
                      {attachmentHint}
                    </span>
                  )}
                </div>

                {stagedAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2" data-testid="bug-report-attachments">
                    {stagedAttachments.map((attachment) => (
                      <div
                        key={attachment.id}
                        className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/70 bg-muted"
                        data-testid="bug-report-attachment-thumbnail"
                      >
                        <img
                          src={attachment.previewUrl}
                          alt={attachment.name}
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveAttachment(attachment.id)}
                          aria-label={t('bugReport.removeScreenshot', { name: attachment.name })}
                          data-testid="bug-report-attachment-remove"
                          className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* The one-line notice §9 requires: shown only once something
                    is actually staged, because only then does it apply. */}
                {stagedAttachments.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">{privacyNotice()}</p>
                )}
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

        {showsForm && (
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
