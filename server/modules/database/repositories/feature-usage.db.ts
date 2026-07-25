/**
 * Local feature-usage counters (issue #248).
 *
 * Aggregate only: one row per feature key holding a count and the first/last
 * time it was touched. No event log, no arguments, no content — see the
 * `feature_usage` table comment in schema.ts.
 *
 * **Recording is best-effort by contract.** `recordFeatureUses` never throws:
 * a locked database, a missing table, an unwritable path, or recording being
 * switched off must never break the user action that was being counted. Reads
 * (`listUsage`, `clearUsage`) are allowed to throw — their only caller is the
 * `cloudcli usage` CLI, where a failure should be visible rather than silent.
 */

import type BetterSqlite3 from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import { FEATURE_USAGE_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

import { FEATURE_KEYS, isFeatureKey, type FeatureKey } from '../../../../shared/featureKeys.js';

/** One inventory entry as the readout presents it (zero-filled if never used). */
export type FeatureUsageEntry = {
  featureKey: FeatureKey;
  useCount: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
};

type FeatureUsageRow = {
  feature_key: string;
  use_count: number;
  first_used_at: string | null;
  last_used_at: string | null;
};

const UPSERT_SQL = `
  INSERT INTO feature_usage (feature_key, use_count, first_used_at, last_used_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(feature_key) DO UPDATE SET
    use_count = feature_usage.use_count + excluded.use_count,
    first_used_at = COALESCE(feature_usage.first_used_at, excluded.first_used_at),
    last_used_at = excluded.last_used_at
`;

/**
 * Values that switch recording off. Anything else (including the variable being
 * unset) leaves it on, so the counters work out of the box on this single-user
 * install and opting out is an explicit act.
 */
const DISABLED_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);

/**
 * The off switch: `FEATURE_USAGE_ENABLED=false` in `.env` stops all recording.
 *
 * Read from the environment at call time rather than frozen at import, so the
 * flag is testable and a restart is the only thing needed to flip it.
 */
export const isFeatureUsageEnabled = (): boolean => {
  const raw = process.env.FEATURE_USAGE_ENABLED;
  if (raw === undefined || raw.trim() === '') return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
};

/**
 * SQLite's own `CURRENT_TIMESTAMP` format ("YYYY-MM-DD HH:MM:SS", UTC), matching
 * every other timestamp column in this database. `now` is injectable so tests
 * can assert first/last-used movement without sleeping through a clock tick.
 */
const toSqliteTimestamp = (now: Date): string => now.toISOString().slice(0, 19).replace('T', ' ');

/**
 * The readout has to work against a database that a newer server has not booted
 * against yet (the CLI can run before the migration has), so the read paths
 * create the table on demand. Cheap and idempotent.
 */
const ensureTable = (db: BetterSqlite3.Database): void => {
  db.exec(FEATURE_USAGE_TABLE_SCHEMA_SQL);
};

/** Collapses a batch of key hits into one increment per distinct key. */
const tally = (keys: readonly unknown[]): Map<FeatureKey, number> => {
  const counts = new Map<FeatureKey, number>();
  for (const key of keys) {
    if (!isFeatureKey(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

export const featureUsageDb = {
  isEnabled: isFeatureUsageEnabled,

  /**
   * Counts a batch of feature hits. Unknown keys are dropped, not stored.
   *
   * Returns the number of hits actually recorded (0 when disabled or on any
   * failure). **Never throws** — callers on a user-action path rely on that.
   */
  recordFeatureUses(keys: readonly unknown[], now: Date = new Date()): number {
    try {
      if (!isFeatureUsageEnabled()) return 0;

      const counts = tally(keys);
      if (counts.size === 0) return 0;

      const timestamp = toSqliteTimestamp(now);
      const db = getConnection();
      const statement = db.prepare(UPSERT_SQL);
      const writeAll = db.transaction((entries: [FeatureKey, number][]) => {
        for (const [key, count] of entries) {
          statement.run(key, count, timestamp, timestamp);
        }
      });
      writeAll([...counts.entries()]);

      let recorded = 0;
      for (const count of counts.values()) recorded += count;
      return recorded;
    } catch (error) {
      // Best-effort by contract: usage counting is never worth failing a user
      // action over. Log once at debug volume and carry on.
      const message = error instanceof Error ? error.message : String(error);
      console.warn('Feature usage not recorded:', message);
      return 0;
    }
  },

  /**
   * Every key in the inventory, zero-filled for the ones never touched, sorted
   * least-used first. The zeros are the whole point of the readout, so they are
   * produced here rather than left to the caller.
   */
  listUsage(): FeatureUsageEntry[] {
    const db = getConnection();
    ensureTable(db);

    const rows = db
      .prepare('SELECT feature_key, use_count, first_used_at, last_used_at FROM feature_usage')
      .all() as FeatureUsageRow[];

    const byKey = new Map(rows.map((row) => [row.feature_key, row]));

    return FEATURE_KEYS.map((featureKey): FeatureUsageEntry => {
      const row = byKey.get(featureKey);
      return {
        featureKey,
        useCount: row?.use_count ?? 0,
        firstUsedAt: row?.first_used_at ?? null,
        lastUsedAt: row?.last_used_at ?? null,
      };
    }).sort((a, b) => {
      if (a.useCount !== b.useCount) return a.useCount - b.useCount;
      // Among equal counts, the stalest feature floats up: never-used first,
      // then oldest last-used, then alphabetically for a stable order.
      const left = a.lastUsedAt ?? '';
      const right = b.lastUsedAt ?? '';
      if (left !== right) return left < right ? -1 : 1;
      return a.featureKey < b.featureKey ? -1 : 1;
    });
  },

  /** Wipes every counter. Returns how many rows were deleted. */
  clearUsage(): number {
    const db = getConnection();
    ensureTable(db);
    return db.prepare('DELETE FROM feature_usage').run().changes;
  },
};
