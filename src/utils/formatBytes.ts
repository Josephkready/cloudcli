/**
 * Human-readable byte sizes, shared by every surface that shows one.
 *
 * The file tree and the skills uploader each had their own: the tree scaled
 * through PB with clamped bounds, the uploader stopped at MB and rendered a
 * redundant `.0`. Same number, two different strings, one screen apart.
 */
export function formatFileSize(bytes?: number): string {
  // Reject 0/undefined plus out-of-domain inputs (negative, NaN, Infinity):
  // `Math.log` of those yields NaN, and `Math.min/max` propagate NaN, so they
  // can't be salvaged by clamping and would render as `NaN`/`undefined`.
  if (!bytes || !Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }

  const base = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  // Clamp both ends of the unit index: sub-1-byte values (index < 0) fall into
  // `B`, and sizes beyond the last unit (>= 1 EB) render as `PB` — never walking
  // off either end of `sizes` into `undefined`.
  const rawIndex = Math.floor(Math.log(bytes) / Math.log(base));
  const index = Math.min(Math.max(rawIndex, 0), sizes.length - 1);

  return `${(bytes / Math.pow(base, index)).toFixed(1).replace(/\.0$/, '')} ${sizes[index]}`;
}
