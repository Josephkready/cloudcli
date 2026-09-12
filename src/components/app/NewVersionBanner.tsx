import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, X } from 'lucide-react';

import { shouldAutoReload } from '../../hooks/buildVersion';

interface NewVersionBannerProps {
  /**
   * A newer build is deployed than the one this tab is running (see useVersionCheck).
   * Latched once true — an old bundle can never become current again.
   */
  newBuildAvailable: boolean;
  /**
   * Returns whether reloading is safe right now (no in-flight stream and no unsent
   * composer text). Called at the moment of the auto-reload decision rather than at
   * render time, so a composer keystroke that never re-rendered this component cannot
   * leave a stale "idle" answer that lets reload eat the draft.
   */
  isIdle: () => boolean;
}

/**
 * Non-blocking "new version available" banner (#458).
 *
 * Shows a small toast with a manual reload button and a dismiss control whenever
 * useVersionCheck detects that a new build has been deployed. It NEVER reloads
 * mid-conversation: auto-reload only fires on a `visibilitychange` where the tab returns
 * from hidden to visible AND the app is idle at that moment — which is exactly when a
 * phone PWA tab (rarely closed, backgrounded for days) comes back to the foreground.
 * The banner is `pointer-events-none` so it never blocks the UI beneath it; only the
 * toast itself is interactive.
 */
export default function NewVersionBanner({ newBuildAvailable, isIdle }: NewVersionBannerProps) {
  const { t } = useTranslation('common');
  const [dismissed, setDismissed] = useState(false);
  const reloadedRef = useRef(false);
  const wasHiddenRef = useRef(false);
  const latestRef = useRef({ newBuildAvailable, isIdle });
  latestRef.current = { newBuildAvailable, isIdle };

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasHiddenRef.current = true;
        return;
      }
      // Visible again. Auto-reload only for a genuine return-from-hidden (a phone PWA
      // being foregrounded), never on the initial load or a spurious event.
      if (!wasHiddenRef.current) return;
      wasHiddenRef.current = false;
      if (reloadedRef.current) return;

      const { newBuildAvailable: available, isIdle: idleNow } = latestRef.current;
      if (shouldAutoReload({ newBuildAvailable: available, isIdle: idleNow(), becameVisibleAfterHidden: true })) {
        reloadedRef.current = true;
        window.location.reload();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  if (dismissed || !newBuildAvailable) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2 text-sm text-foreground shadow-lg"
      >
        <RefreshCw className="h-4 w-4 flex-shrink-0 text-primary" />
        <span>{t('versionUpdate.newBuild.message')}</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('versionUpdate.newBuild.reload')}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label={t('versionUpdate.newBuild.dismiss')}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
