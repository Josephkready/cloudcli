import type { PermissionMode } from '../types/types';

/**
 * Translation keys for the composer's permission-mode pill (#239).
 *
 * The pill used to render its label through a chain of `mode === '…' && t(…)`
 * expressions inside a span that was `hidden sm:inline`, so below 640px — every
 * phone — the control collapsed to an unlabelled colour dot. Permission mode
 * decides whether the agent asks before acting, so `bypassPermissions` could be
 * live with nothing readable to say so.
 *
 * `short` is what stays visible at every width; `full` takes over once there is
 * room. Keeping both in one table means a new mode cannot be added with only
 * half its labels.
 */
export const PERMISSION_MODE_LABEL_KEYS: Record<PermissionMode, { full: string; short: string }> = {
  default: { full: 'codex.modes.default', short: 'codex.modesShort.default' },
  acceptEdits: { full: 'codex.modes.acceptEdits', short: 'codex.modesShort.acceptEdits' },
  auto: { full: 'codex.modes.auto', short: 'codex.modesShort.auto' },
  bypassPermissions: {
    full: 'codex.modes.bypassPermissions',
    short: 'codex.modesShort.bypassPermissions',
  },
  plan: { full: 'codex.modes.plan', short: 'codex.modesShort.plan' },
};

const FALLBACK = PERMISSION_MODE_LABEL_KEYS.default;

/**
 * `permissionMode` is typed `PermissionMode | string` at the composer boundary
 * (it round-trips through storage and the wire), so an unrecognised value must
 * still produce a labelled pill rather than an empty one.
 */
export function getPermissionModeLabelKeys(mode: PermissionMode | string): {
  full: string;
  short: string;
} {
  return PERMISSION_MODE_LABEL_KEYS[mode as PermissionMode] ?? FALLBACK;
}
