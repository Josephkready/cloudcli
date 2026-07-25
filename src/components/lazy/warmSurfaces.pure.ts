/**
 * Policy for the lazy-surface warm-up (issue #267), kept React-free so the
 * decision itself can be covered by the fast `node:test` runner.
 */

export type ConnectionLike = {
  saveData?: boolean;
  effectiveType?: string;
};

/**
 * Should we spend bandwidth and a slice of idle CPU pulling surfaces the user
 * has not asked for yet?
 *
 * Warming is a bet: it makes the first click on Shell or the editor instant, at
 * the cost of ~276 KB and a few tens of milliseconds of idle main-thread time
 * for everyone — including sessions that never leave the chat tab. On a metered
 * or 2G connection that bet is a bad one, and both signals are cheap to read.
 * Absent the API entirely (Safari, Firefox), warm: that is the same default the
 * browser applies to `<link rel=prefetch>`.
 */
export function shouldWarmSurfaces(connection: ConnectionLike | undefined | null): boolean {
  if (!connection) return true;
  if (connection.saveData === true) return false;
  if (typeof connection.effectiveType === 'string' && /2g$/i.test(connection.effectiveType)) return false;
  return true;
}
