import { useCallback, useEffect, useRef, useState } from 'react';

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
 *
 * `checkNow` is exposed separately from the background polling for exactly one caller:
 * `NewVersionBanner`'s own resume handler. A build that lands while the tab is backgrounded
 * has not been picked up by any fetch yet, and the `newBuildAvailable` *value* returned by
 * this hook cannot reflect that until a fetch this hook triggers resolves and re-renders —
 * which cannot happen inside the same synchronous `visibilitychange` dispatch that both this
 * hook's own resume listener and the banner's fire on. Reading the (necessarily stale) prop
 * at that instant would silently skip auto-reload on the very resume that matters and only
 * catch up on a *second* hide/show cycle. `checkNow` lets the banner await a fresh answer
 * from the same request instead of racing it.
 */
export const useVersionCheck = () => {
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [serverBuild, setServerBuild] = useState<ServerBuildIdentity | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [newBuildAvailable, setNewBuildAvailable] = useState(false);

  // Once a new build is detected it can never become "not new" again — this bundle cannot
  // un-stale itself. Mirrored in a ref (rather than read back from state) so `checkNow` can
  // hand its caller the fresh, already-latched answer in the same call that computed it,
  // without waiting for the state update it also issues to flow through a re-render.
  const newBuildAvailableRef = useRef(false);
  // Guards against setting state after unmount while a fetch this hook started is still in
  // flight (a callback-based replacement for the effect-scoped `cancelled` flag this used
  // before `checkNow` needed to be callable independently of any single effect run).
  const unmountedRef = useRef(false);
  useEffect(() => () => {
    unmountedRef.current = true;
  }, []);

  const checkNow = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch('/health');
      const data = await response.json();
      if (unmountedRef.current) return newBuildAvailableRef.current;

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

      const isNew = newBuildAvailableRef.current || resolveNewBuildAvailable({
        embeddedSha: BUILD_SHA,
        embeddedVersion: version,
        serverSha: build?.sha,
        serverVersion,
      });
      newBuildAvailableRef.current = isNew;
      setNewBuildAvailable(isNew);
      return isNew;
    } catch (error) {
      console.error('[useVersionCheck] Failed to check /health:', error);
      return newBuildAvailableRef.current;
    }
  }, []);

  useEffect(() => {
    const run = () => void checkNow();

    run();

    const interval = setInterval(run, VERSION_CHECK_INTERVAL_MS);

    // A phone PWA tab is rarely closed, so resuming is exactly when it should notice a
    // deploy that landed while it was backgrounded. Mirrors the WebSocket liveness probe's
    // resume hook (WebSocketContext). This background poll's own resolution is what
    // eventually surfaces a deploy missed by a resume decision made before it landed;
    // `NewVersionBanner`'s resume handler additionally calls `checkNow` directly so it does
    // not have to wait for this one to happen to have already run.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        run();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [checkNow]);

  return {
    currentVersion: version,
    installMode,
    runningVersion,
    restartRequired,
    newBuildAvailable,
    build: serverBuild,
    checkNow,
  };
};
