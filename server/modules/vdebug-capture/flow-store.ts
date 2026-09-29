/**
 * video-debugger Phase 1 — the Node port of `flowstore.ingest`.
 *
 * `public/vd-recorder.js` POSTs batches of SEMANTIC intent events (route
 * changes, clicks, submits, coarse scroll, JS errors) to `/api/_vd/events`.
 * This module validates them and stores them in a SQLite db whose schema is
 * `vdebug/capture/schema.sql` — the same file `vdebug/capture/flowstore.py`
 * applies, so `flowstore.py mine|stats|prune` runs against the db this writes.
 * `FLOWS_SCHEMA_SQL` below is a verbatim copy of that file (a test pins the
 * two together), inlined because `tsc` does not ship `.sql` files into
 * `dist-server/`.
 *
 * The client is untrusted. Everything is re-validated here: an event-type
 * allowlist, a per-type payload-key allowlist, string caps, and
 * `INSERT OR IGNORE` on `(session_id, seq)` so a re-sent batch is idempotent.
 * A tampered client can add noise but can never widen what is stored.
 *
 * Privacy (stricter than the upstream template, on purpose — session content
 * in this app is highly sensitive):
 *   - no input values: `input` events carry only `{kind, length}`;
 *   - `nav.title` is DROPPED: the tab title here carries the selected project's
 *     name, so it is never stored even if a client sends it;
 *   - no query values: `path` keeps query keys only, re-applied server-side;
 *   - no raw user agent: reduced to mobile|tablet|desktop;
 *   - `change.value` is the one field whose *content* the server cannot judge:
 *     the recorder only sends it for elements opted in with
 *     `data-vd-capture-value` (none are, today). The server caps its length.
 *   - store-wide ceilings (MAX_TOTAL_SESSIONS / MAX_TOTAL_EVENTS) bound the db
 *     even against a client that mints a new session id per request;
 *   - the recorder already omits accessible names under `[data-vd-mask]`
 *     (transcript, composer, conversation list, search results).
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export const FLOWS_SCHEMA_SQL = `-- video-debugger flow-capture store (Phase 1).
-- One SQLite file per app, at a STATE path (e.g. /var/lib/<app>/flows.db) — never
-- inside the deployed code tree, which the next deploy clobbers.
-- flowstore.py applies this idempotently on open; keep it the single source of truth.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,          -- client-generated random id (not a user id)
    started_at   TEXT NOT NULL,             -- server clock, ISO-8601 UTC, first batch seen
    last_seen_at TEXT NOT NULL,             -- server clock, last batch seen
    viewport_w   INTEGER,                   -- viewport at session start (for matrix coverage)
    viewport_h   INTEGER,
    ua_class     TEXT,                      -- 'mobile' | 'tablet' | 'desktop' — never the raw UA
    event_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,           -- client order within the session
    t_ms        INTEGER NOT NULL,           -- ms since session start (client monotonic clock)
    type        TEXT NOT NULL,              -- nav | click | input | change | submit | scroll | resize | error
    path        TEXT,                       -- location.pathname (query values stripped client-side)
    target      TEXT,                       -- JSON: {testid, id, role, name, tag, css} — locator hints
    data        TEXT,                       -- JSON: type-specific payload (never raw input values)
    UNIQUE (session_id, seq)                -- makes re-sent batches idempotent
);

CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen_at);

-- Canonical flows the agent has promoted from mined sessions into Playwright scripts.
-- Lets \`flowstore.py mine\` mark which clusters are already covered by a vdebug flow.
CREATE TABLE IF NOT EXISTS flows (
    id          TEXT PRIMARY KEY,           -- the route signature hash from \`mine\`
    name        TEXT NOT NULL,              -- vdebug flow NAME that covers it
    signature   TEXT NOT NULL,              -- JSON list of steps the cluster collapses to
    sessions    INTEGER NOT NULL,           -- sessions in the cluster when promoted
    promoted_at TEXT NOT NULL
);
`;

export const EVENT_TYPES = new Set(['nav', 'click', 'input', 'change', 'submit', 'scroll', 'resize', 'error']);
const TARGET_KEYS = ['testid', 'id', 'role', 'name', 'tag', 'css'] as const;
/** Per-type payload allowlist. Anything else the client sends is discarded. */
export const DATA_KEYS: Record<string, readonly string[]> = {
  nav: ['kind'], // NOT 'title' — see the privacy note at the top of this file
  click: ['x', 'y'],
  input: ['kind', 'length'],
  change: ['kind', 'value'], // value only arrives for elements the app opted in (data-vd-capture-value)
  submit: [],
  scroll: ['depth_pct'],
  resize: ['w', 'h'],
  error: ['message', 'source'],
};
export const MAX_EVENTS_PER_BATCH = 500;
export const MAX_STR = 200;
export const MAX_EVENTS_PER_SESSION = 5000;
/**
 * Store-wide ceilings. `session_id` is client-minted, so the per-session cap alone
 * cannot bound the db: a scripted caller could mint a fresh id per request. Past
 * either ceiling, new sessions are refused (existing ones may still append up to
 * their own cap) until retention pruning frees room.
 */
export const MAX_TOTAL_SESSIONS = 20_000;
export const MAX_TOTAL_EVENTS = 1_000_000;
const SESSION_ID = /^[A-Za-z0-9]{8,64}$/;

/** The batch is malformed; the endpoint answers 400. */
export class BatchError extends Error {}

export type IngestResult = { stored: number; duplicate: number; invalid: number; capped: boolean };

const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

function capStr(value: unknown, cap = MAX_STR): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, cap);
}

/** Python `int()`-alike: accepts integers and integral numeric strings, rejects the rest. */
function toInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string' && /^\s*[-+]?\d+\s*$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON with sorted keys, so rows match what flowstore.py writes (`sort_keys=True`). */
function sortedJson(obj: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return JSON.stringify(out);
}

/**
 * Server-side twin of the recorder's cleanPath(): keep query KEYS, drop their values
 * and any fragment, so a tampered client still cannot store `?q=secret`.
 */
export function cleanPath(value: unknown): string | null {
  const raw = capStr(value, 1000);
  if (raw === null) return null;
  const [pathname, query] = raw.split('#', 1)[0].split(/\?(.*)/s, 2);
  const keys = query
    ? '?' + query.split('&').filter(Boolean).map((kv) => `${kv.split('=')[0]}=`).join('&')
    : '';
  return (pathname + keys).slice(0, MAX_STR);
}

function cleanTarget(target: unknown): string | null {
  if (!isRecord(target)) return null;
  const out: Record<string, unknown> = {};
  for (const key of TARGET_KEYS) {
    const value = target[key];
    if (value !== null && value !== undefined && value !== '') out[key] = capStr(value);
  }
  return Object.keys(out).length ? sortedJson(out) : null;
}

function cleanData(type: string, data: unknown): string | null {
  if (!isRecord(data)) return null;
  const out: Record<string, unknown> = {};
  for (const key of DATA_KEYS[type]) {
    const value = data[key];
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'number' || typeof value === 'boolean' ? value : capStr(value);
  }
  return Object.keys(out).length ? sortedJson(out) : null;
}

/** Coarse device class. The raw UA is never stored (fingerprinting surface). */
export function uaClass(userAgent: string | undefined | null, viewportW: number | null): string {
  const ua = (userAgent || '').toLowerCase();
  if (ua.includes('ipad') || ua.includes('tablet')) return 'tablet';
  if (ua.includes('mobi') || ua.includes('android') || ua.includes('iphone')) return 'mobile';
  if (viewportW !== null) return viewportW < 600 ? 'mobile' : viewportW < 1024 ? 'tablet' : 'desktop';
  return 'desktop';
}

export class FlowStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { timeout: 10_000 });
    this.db.pragma('foreign_keys = ON');
    this.db.exec(FLOWS_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  /** Validate and store one recorder batch. Throws BatchError on a malformed batch. */
  ingest(batch: unknown, options: { userAgent?: string | null } = {}): IngestResult {
    if (!isRecord(batch)) throw new BatchError('batch must be an object');
    const sid = batch.session_id;
    if (typeof sid !== 'string' || !SESSION_ID.test(sid)) {
      throw new BatchError('session_id must be 8-64 alphanumerics');
    }
    const events = batch.events;
    if (!Array.isArray(events) || events.length === 0) throw new BatchError('events must be a non-empty list');
    if (events.length > MAX_EVENTS_PER_BATCH) {
      throw new BatchError(`at most ${MAX_EVENTS_PER_BATCH} events per batch`);
    }
    const viewport = isRecord(batch.viewport) ? batch.viewport : {};
    const vw = toInt(viewport.w);
    const vh = toInt(viewport.h);

    const now = nowIso();
    const run = this.db.transaction((): IngestResult => {
      const row = this.db.prepare('SELECT event_count FROM sessions WHERE id = ?').get(sid) as
        | { event_count: number }
        | undefined;
      let count = 0;
      if (!row) {
        const totals = this.db
          .prepare('SELECT COUNT(*) AS sessions, COALESCE(SUM(event_count), 0) AS events FROM sessions')
          .get() as { sessions: number; events: number };
        if (totals.sessions >= MAX_TOTAL_SESSIONS || totals.events >= MAX_TOTAL_EVENTS) {
          return { stored: 0, duplicate: 0, invalid: 0, capped: true };
        }
        this.db
          .prepare(
            'INSERT INTO sessions (id, started_at, last_seen_at, viewport_w, viewport_h, ua_class) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(sid, now, now, vw, vh, uaClass(options.userAgent, vw));
      } else {
        count = row.event_count;
      }
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO events (session_id, seq, t_ms, type, path, target, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      let stored = 0;
      let invalid = 0;
      let duplicate = 0;
      let capped = false;
      for (const ev of events) {
        if (count + stored >= MAX_EVENTS_PER_SESSION) {
          capped = true;
          break;
        }
        if (!isRecord(ev) || typeof ev.type !== 'string' || !EVENT_TYPES.has(ev.type)) {
          invalid += 1;
          continue;
        }
        const seq = toInt(ev.seq);
        const tMs = toInt(ev.t);
        if (seq === null || tMs === null || seq < 0 || tMs < 0) {
          invalid += 1;
          continue;
        }
        const changes = insert.run(
          sid, seq, tMs, ev.type, cleanPath(ev.path), cleanTarget(ev.target), cleanData(ev.type, ev.data),
        ).changes;
        stored += changes;
        duplicate += 1 - changes;
      }
      this.db
        .prepare('UPDATE sessions SET last_seen_at = ?, event_count = event_count + ? WHERE id = ?')
        .run(now, stored, sid);
      return { stored, duplicate, invalid, capped };
    });
    return run();
  }

  /** Delete sessions (and, via cascade, their events) not seen for `days`. Returns sessions removed. */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
    return this.db.prepare('DELETE FROM sessions WHERE last_seen_at < ?').run(cutoff).changes;
  }
}
