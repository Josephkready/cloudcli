import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';

/**
 * Catch-all state for paths the router does not know (#233).
 *
 * The server serves `dist/index.html` for unknown paths (SPA fallback), so a
 * stale bookmark or a typo returns HTTP 200 and the browser reports no error.
 * Without this the user got a blank pane and no affordance to get back.
 */
export default function NotFound() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
        <Compass className="h-7 w-7 text-muted-foreground" />
      </div>
      <h1 className="mb-2 text-xl font-semibold text-foreground">{t('notFound.title')}</h1>
      <p className="mb-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {t('notFound.description')}
      </p>
      <p className="mb-5 max-w-md truncate font-mono text-xs text-muted-foreground/70" title={pathname}>
        {pathname}
      </p>
      <Link
        to="/"
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {t('notFound.backToApp')}
      </Link>
    </div>
  );
}
