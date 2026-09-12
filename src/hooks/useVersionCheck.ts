import { useState, useEffect } from 'react';

import { version } from '../../package.json';
import { BUILD_SHA } from '../constants/build';

import { resolveNewBuildAvailable, type ServerBuildIdentity } from './buildVersion';

export type InstallMode = 'git' | 'npm';

/** How often an open tab re-checks /health for a freshly deployed build (#458). */
const VERSION_CHECK_INTERVAL_MS = 60_000;

/**
 * Reads `/health` to surface how the server was installed and whether the code this tab is
 * running matches what the server now serves.
 *
 * Two different "out of date" signals, with different remedies:
 *
 *  - `restartRequired`: the server process's package.json version differs from the
 *    frontend's build-time version — the package was updated on disk but the long-lived
 *    server process was not restarted, so DB-backed actions may fail. Fixed by a restart.
 *  - `newBuildAvailable`: the server's build identity (git SHA, stamped by
 *    scripts/dante-build.sh) differs from the one baked into this tab's bundle. The tab is
 *    running an old bundle against a patched server — fixed by a page reload. This is the
 *    #458 check: this fork ships by ansible-pull with no version bumps, so the semver can
 *    never detect a new deploy on its own. The embedded SHA is compared when present, with
 *    the historical semver comparison as a fallback for dev servers / pre-change servers.
 *
 * The check re-runs periodically and on tab resume, so a deploy that lands while a tab
 * (especially the iPhone PWA, which is rarely closed) sits open is noticed within a
 * minute rather than on the next manual reload.
 */
export const useVersionCheck = () => {
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [serverBuild, setServerBuild] = useState<ServerBuildIdentity | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [newBuildAvailable, setNewBuildAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (cancelled) return;

        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }

        const serverVersion: string | null = typeof data.version === 'string' && data.version.length > 0
          ? data.version
          : null;
        if (serverVersion) {
          setRunningVersion(serverVersion);
          setRestartRequired(serverVersion !== version);
        }

        const build =
          data.build && typeof data.build === 'object'
            ? {
                sha: typeof data.build.sha === 'string' && data.build.sha ? data.build.sha : null,
                built_at:
                  typeof data.build.built_at === 'string' && data.build.built_at ? data.build.built_at : null,
              }
            : null;
        setServerBuild((prev) => {
          if (prev?.sha === build?.sha && prev?.built_at === build?.built_at) return prev;
          return build;
        });

        // Once a new build is detected it can never become "not new" again — this bundle
        // cannot un-stale itself — so the flag is latched rather than recomputed.
        setNewBuildAvailable((prev) => prev || resolveNewBuildAvailable({
          embeddedSha: BUILD_SHA,
          embeddedVersion: version,
          serverSha: build?.sha,
          serverVersion,
        }));
      } catch {
        // Default to git / no restart hint on error
      }
    };

    void fetchHealth();

    const interval = setInterval(() => void fetchHealth(), VERSION_CHECK_INTERVAL_MS);

    // A phone PWA tab is rarely closed, so resuming is exactly when it should notice a
    // deploy that landed while it was backgrounded. Mirrors the WebSocket liveness probe's
    // resume hook (WebSocketContext).
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchHealth();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return { currentVersion: version, installMode, runningVersion, restartRequired, newBuildAvailable, build: serverBuild };
};
