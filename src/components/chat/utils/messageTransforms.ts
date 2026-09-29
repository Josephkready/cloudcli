export interface DiffLine {
  type: 'added' | 'removed';
  content: string;
  lineNum: number;
}

export type DiffCalculator = (oldStr: string, newStr: string) => DiffLine[];

export const calculateDiff = (oldStr: string, newStr: string): DiffLine[] => {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // Use LCS alignment so insertions/deletions don't cascade into a full-file "changed" diff.
  const lcsTable: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    new Array<number>(newLines.length + 1).fill(0),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        lcsTable[oldIndex][newIndex] = lcsTable[oldIndex + 1][newIndex + 1] + 1;
      } else {
        lcsTable[oldIndex][newIndex] = Math.max(
          lcsTable[oldIndex + 1][newIndex],
          lcsTable[oldIndex][newIndex + 1],
        );
      }
    }
  }

  const diffLines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];

    if (oldLine === newLine) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (lcsTable[oldIndex + 1][newIndex] >= lcsTable[oldIndex][newIndex + 1]) {
      diffLines.push({ type: 'removed', content: oldLine, lineNum: oldIndex + 1 });
      oldIndex += 1;
      continue;
    }

    diffLines.push({ type: 'added', content: newLine, lineNum: newIndex + 1 });
    newIndex += 1;
  }

  while (oldIndex < oldLines.length) {
    diffLines.push({ type: 'removed', content: oldLines[oldIndex], lineNum: oldIndex + 1 });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    diffLines.push({ type: 'added', content: newLines[newIndex], lineNum: newIndex + 1 });
    newIndex += 1;
  }

  return diffLines;
};

const DIFF_CACHE_MAX_ENTRIES = 100;

/**
 * Bounded LRU-by-insertion cache for `calculateDiff`, keyed by the strings
 * themselves via a two-level `Map` (outer keyed by `oldStr`, inner by
 * `newStr`) instead of `JSON.stringify([oldStr, newStr])`.
 *
 * The old key scheme serialized both full strings on *every* lookup, cache
 * hits included — for a large file edit (tens of KB before/after) that's
 * ~2x the content size re-stringified per call. `Map` already compares
 * string keys by value (`SameValueZero`), so nesting two of them gets an
 * O(1) hash lookup with none of that copying.
 */
export const createCachedDiffCalculator = (): DiffCalculator => {
  const cache = new Map<string, Map<string, DiffLine[]>>();
  // Insertion order across the whole (oldStr, newStr) key space, so eviction
  // keeps evicting the single oldest entry — same bound and same "oldest
  // wins" behaviour the flat-Map version got for free from Map iteration
  // order.
  const insertionOrder: Array<{ oldStr: string; newStr: string }> = [];

  return (oldStr: string, newStr: string) => {
    const inner = cache.get(oldStr);
    const cached = inner?.get(newStr);
    if (cached) {
      return cached;
    }

    const calculated = calculateDiff(oldStr, newStr);
    const bucket = inner ?? new Map<string, DiffLine[]>();
    bucket.set(newStr, calculated);
    if (!inner) {
      cache.set(oldStr, bucket);
    }
    insertionOrder.push({ oldStr, newStr });

    if (insertionOrder.length > DIFF_CACHE_MAX_ENTRIES) {
      const oldest = insertionOrder.shift();
      if (oldest) {
        const oldestBucket = cache.get(oldest.oldStr);
        oldestBucket?.delete(oldest.newStr);
        if (oldestBucket && oldestBucket.size === 0) {
          cache.delete(oldest.oldStr);
        }
      }
    }

    return calculated;
  };
};
