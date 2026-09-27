import { getConnection } from '@/modules/database/connection.js';
import type { AnyRecord } from '@/shared/types.js';

/**
 * Lifecycle states of a durably-journaled chat run (see the `active_runs` table
 * comment in schema.ts):
 * - `running`     — the message whose provider run is live right now.
 * - `queued`      — a message waiting in the session's server-side FIFO queue.
 * - `interrupted` — a `running`/`queued` row left behind by a previous process,
 *   flagged by the startup reconcile so the user can resume it (issue #70).
 */
type ActiveRunStatus = 'running' | 'queued' | 'interrupted';

type ActiveRunRow = {
  id: number;
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  content: string;
  options_json: string;
  user_id: string | null;
  status: ActiveRunStatus;
  enqueued_at: number;
  created_at: string;
};

/** Everything needed to durably record one accepted chat.send message. */
export type PersistRunInput = {
  sessionId: string;
  provider: string;
  providerSessionId: string | null;
  content: string;
  options: AnyRecord | undefined;
  userId: string | number | null;
  enqueuedAt: number;
};

const ACTIVE_RUN_COLUMNS =
  'id, session_id, provider, provider_session_id, content, options_json, user_id, status, enqueued_at, created_at';

function serializeOptions(options: AnyRecord | undefined): string {
  try {
    return JSON.stringify(options ?? {});
  } catch {
    // A non-serializable options object must never abort the run's persistence;
    // fall back to empty options rather than throwing on the chat.send path.
    return '{}';
  }
}

function serializeUserId(userId: string | number | null): string | null {
  return userId === null || userId === undefined ? null : String(userId);
}

function insert(input: PersistRunInput, status: ActiveRunStatus): number {
  const db = getConnection();
  const result = db
    .prepare(
      `INSERT INTO active_runs
         (session_id, provider, provider_session_id, content, options_json, user_id, status, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.sessionId,
      input.provider,
      input.providerSessionId,
      input.content,
      serializeOptions(input.options),
      serializeUserId(input.userId),
      status,
      input.enqueuedAt
    );

  return Number(result.lastInsertRowid);
}

/**
 * Durable journal of in-flight and queued chat runs. Mirrors the in-memory run
 * registry so that after a restart the startup reconcile can surface interrupted
 * work as resumable rather than silently dropping it (issue #70).
 */
export const activeRunsDb = {
  /** Records the message that just started a live run. Returns the row id. */
  recordRunning(input: PersistRunInput): number {
    return insert(input, 'running');
  },

  /** Records a message appended to the session's FIFO queue. Returns the row id. */
  recordQueued(input: PersistRunInput): number {
    return insert(input, 'queued');
  },

  /**
   * Stores the provider-native session id captured mid-run, so a post-restart
   * resume can address the provider transcript (resume by provider session id).
   */
  setProviderSessionId(id: number, providerSessionId: string): void {
    const db = getConnection();
    db.prepare('UPDATE active_runs SET provider_session_id = ? WHERE id = ?').run(providerSessionId, id);
  },

  /**
   * Promotes a queued row to running when its turn arrives, carrying forward the
   * provider-native id resolved by the previous run (COALESCE keeps a value the
   * row may already hold if it was recorded with one).
   */
  promoteToRunning(id: number, providerSessionId: string | null): void {
    const db = getConnection();
    db.prepare(
      `UPDATE active_runs
       SET status = 'running',
           provider_session_id = COALESCE(?, provider_session_id)
       WHERE id = ?`
    ).run(providerSessionId, id);
  },

  /** Deletes one journaled row (run completed, aborted, or dequeued+discarded). */
  remove(id: number): void {
    const db = getConnection();
    db.prepare('DELETE FROM active_runs WHERE id = ?').run(id);
  },

  /** Deletes every journaled row for a session. Returns how many were removed. */
  removeBySession(sessionId: string): number {
    const db = getConnection();
    return db.prepare('DELETE FROM active_runs WHERE session_id = ?').run(sessionId).changes;
  },

  /**
   * Startup reconcile: flags every row still marked `running`/`queued` — i.e.
   * left behind by a previous process — as `interrupted`, so the user can resume
   * it. Idempotent: rows already `interrupted` (an earlier reconcile that was
   * never resumed) are left untouched. Returns the affected session ids and the
   * number of messages flagged.
   */
  markAllInterrupted(): { sessions: string[]; messages: number } {
    const db = getConnection();
    const reconcile = db.transaction((): { sessions: string[]; messages: number } => {
      const rows = db
        .prepare(
          `SELECT DISTINCT session_id FROM active_runs WHERE status IN ('running', 'queued')`
        )
        .all() as Array<{ session_id: string }>;

      const result = db
        .prepare(`UPDATE active_runs SET status = 'interrupted' WHERE status IN ('running', 'queued')`)
        .run();

      return { sessions: rows.map((row) => row.session_id), messages: result.changes };
    });

    return reconcile();
  },

  /** Interrupted rows for a session, oldest first (resume dispatch order). */
  getInterrupted(sessionId: string): ActiveRunRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ${ACTIVE_RUN_COLUMNS} FROM active_runs
         WHERE session_id = ? AND status = 'interrupted'
         ORDER BY enqueued_at ASC, id ASC`
      )
      .all(sessionId) as ActiveRunRow[];
  },

  /** Whether a session has any interrupted (resumable) work waiting. */
  hasInterrupted(sessionId: string): boolean {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT 1 FROM active_runs WHERE session_id = ? AND status = 'interrupted' LIMIT 1`
      )
      .get(sessionId);
    return Boolean(row);
  },

  /** Distinct session ids with interrupted work (introspection / reconcile logs). */
  listInterruptedSessionIds(): string[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT DISTINCT session_id FROM active_runs WHERE status = 'interrupted'`)
      .all() as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  },

  /** All journaled rows for a session, oldest first (test/introspection helper). */
  getBySession(sessionId: string): ActiveRunRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ${ACTIVE_RUN_COLUMNS} FROM active_runs
         WHERE session_id = ?
         ORDER BY enqueued_at ASC, id ASC`
      )
      .all(sessionId) as ActiveRunRow[];
  },
};
