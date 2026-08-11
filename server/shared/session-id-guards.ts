// Shared guards for user-supplied session ids.
//
// Every session-id validator in the server allows `.` as a body character —
// real ids need it (`v2.0`, `.hidden`) — which means a *bare* dot-only id like
// `.` or `..` satisfies the allow-list pattern while naming a reserved
// filesystem entry. Each validator therefore has to reject the dot-only case
// separately from its pattern. Issue #181 fixed the first such site
// (`parseSessionId`); this module exists so the remaining call sites share one
// definition rather than each re-deriving the regex.

/**
 * All-dots ids (`.`, `..`, `...`, …) — reserved filesystem names that no
 * provider legitimately issues.
 *
 * The guard is deliberately narrow: it matches only ids made *entirely* of
 * dots. An id that merely contains or starts with a dot (`a.b`, `.hidden`)
 * carries non-dot characters, names nothing reserved, and passes.
 */
const RESERVED_DOT_ONLY_ID = /^\.+$/;

/**
 * True when `value` is a reserved dot-only session id.
 *
 * Callers should treat a `true` result as invalid input. Two concrete hazards
 * motivate it: `path.join(base, id)` with a lone `..` resolves to `base`'s
 * parent, and a substring match against directory entries (`name.includes(id)`)
 * with `.` matches essentially every file, so a dot-only id can select an
 * arbitrary session's data instead of none.
 */
export function isReservedDotOnlyId(value: string): boolean {
  return RESERVED_DOT_ONLY_ID.test(value);
}
