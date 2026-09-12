/**
 * Pure build-identity and stale-tab reload logic (#458).
 *
 * Everything here is side-effect free so it can be unit tested directly (tsx --test).
 * The React side lives in `useVersionCheck` (comparison + polling) and
 * `NewVersionBanner` (UX + auto-reload wiring), which call into these functions.
 */

/** `build` payload shape the server serves from /health (see server/shared/build-info.js). */
export type ServerBuildIdentity = {
  sha?: string | null;
  built_at?: string | null;
};

/**
 * Decides whether a newer build is deployed than the one this tab is running.
 *
 * The embedded SHA is the primary signal: the dante fork ships by ansible-pull with no
 * version bumps, so the semver never changes between deploys. When both the bundle and
 * the server carry a SHA, any difference means a new build. When build info is absent on
 * either side (plain `npm run dev`, or a server that predates this change), it falls back
 * to the historical semver comparison — identical to the check `useVersionCheck` ran
 * before #458.
 */
export const resolveNewBuildAvailable = (input: {
  embeddedSha: string;
  embeddedVersion: string;
  serverSha?: string | null;
  serverVersion?: string | null;
}): boolean => {
  const { embeddedSha, embeddedVersion, serverSha, serverVersion } = input;
  if (embeddedSha && serverSha) {
    return embeddedSha !== serverSha;
  }
  return typeof serverVersion === 'string' && serverVersion.length > 0 && serverVersion !== embeddedVersion;
};

/**
 * Whether the app is safe to reload behind the user's back.
 *
 * Auto-reload must never interrupt an in-flight stream or eat unsent composer text, so
 * "idle" means neither is present. `hasInFlightStream` maps to the session-activity map
 * (any session still processing), `hasUnsentComposerText` to the persisted per-project
 * composer draft (see `hasUnsentComposerDraft`).
 */
export const isAppIdle = (input: {
  hasInFlightStream: boolean;
  hasUnsentComposerText: boolean;
}): boolean => !input.hasInFlightStream && !input.hasUnsentComposerText;

/**
 * The auto-reload predicate: reload only when a new build is available AND the app is
 * idle AND the tab just became visible again after being hidden. The last clause is what
 * makes this phone-friendly — a PWA tab is rarely closed, so "returning" is when the user
 * is actually looking at the app again, not mid-conversation.
 */
export const shouldAutoReload = (input: {
  newBuildAvailable: boolean;
  isIdle: boolean;
  becameVisibleAfterHidden: boolean;
}): boolean => input.newBuildAvailable && input.isIdle && input.becameVisibleAfterHidden;

/** localStorage prefix the chat composer persists its draft under (`useChatComposerState`). */
export const DRAFT_INPUT_PREFIX = 'draft_input_';

/**
 * Whether any project has unsent composer text, by scanning localStorage for the
 * per-project draft keys the composer writes on every change and removes on send.
 * A non-empty value under any such key means reloading would lose it.
 */
export const hasUnsentComposerDraft = (storage: Storage | null): boolean => {
  if (!storage) return false;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !key.startsWith(DRAFT_INPUT_PREFIX)) continue;
    const value = storage.getItem(key);
    if (typeof value === 'string' && value.trim().length > 0) return true;
  }
  return false;
};
