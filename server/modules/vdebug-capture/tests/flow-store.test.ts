import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BatchError,
  FLOWS_SCHEMA_SQL,
  FlowStore,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENTS_PER_SESSION,
  MAX_STR,
  uaClass,
} from '../flow-store.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const SCHEMA_SQL_PATH = path.join(REPO_ROOT, 'vdebug', 'capture', 'schema.sql');
const FLOWSTORE_PY = path.join(REPO_ROOT, 'vdebug', 'capture', 'flowstore.py');

function withStore(fn: (store: FlowStore, dbPath: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vd-flowstore-'));
  const dbPath = path.join(dir, 'nested', 'flows.db');
  const store = new FlowStore(dbPath);
  try {
    fn(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

type EventRow = { seq: number; type: string; path: string | null; target: string | null; data: string | null };
const events = (store: FlowStore): EventRow[] =>
  store.db.prepare('SELECT seq, type, path, target, data FROM events ORDER BY seq').all() as EventRow[];

const batch = (evs: unknown[], extra: Record<string, unknown> = {}) => ({
  session_id: 'abc123def456',
  viewport: { w: 390, h: 844 },
  events: evs,
  ...extra,
});

test('FLOWS_SCHEMA_SQL is byte-identical to vdebug/capture/schema.sql (the shared contract)', () => {
  assert.equal(FLOWS_SCHEMA_SQL, readFileSync(SCHEMA_SQL_PATH, 'utf8'));
});

test('rejects malformed batches with BatchError', () => {
  withStore((store) => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      { session_id: 'short', events: [{ seq: 0, t: 0, type: 'click' }] },
      { session_id: 'has-dash-not-alnum', events: [{ seq: 0, t: 0, type: 'click' }] },
      { session_id: 'a'.repeat(65), events: [{ seq: 0, t: 0, type: 'click' }] },
      { session_id: 12345678, events: [{ seq: 0, t: 0, type: 'click' }] },
      batch([]),
      batch('nope' as unknown as unknown[]),
      batch(Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => ({ seq: i, t: i, type: 'click' }))),
    ];
    for (const b of bad) {
      assert.throws(() => store.ingest(b), BatchError, JSON.stringify(b)?.slice(0, 80));
    }
    assert.equal(events(store).length, 0);
  });
});

test('skips invalid events individually and counts them', () => {
  withStore((store) => {
    const result = store.ingest(batch([
      { seq: 0, t: 0, type: 'click' },
      { seq: 1, t: 5, type: 'keylog' }, // not an allowed type
      { seq: 2, t: 5, type: 'nav', data: { kind: 'load' } },
      { seq: -1, t: 5, type: 'click' }, // negative seq
      { seq: 3, t: 'soon', type: 'click' }, // non-integer time
      'not an object',
      { seq: '4', t: '9', type: 'scroll', data: { depth_pct: 50 } }, // numeric strings are fine
    ]));
    assert.deepEqual(result, { stored: 3, duplicate: 0, invalid: 4, capped: false });
    assert.deepEqual(events(store).map((e) => e.seq), [0, 2, 4]);
  });
});

test('re-sent batches are idempotent (UNIQUE(session_id, seq))', () => {
  withStore((store) => {
    const b = batch([
      { seq: 0, t: 0, type: 'nav', data: { kind: 'load' } },
      { seq: 1, t: 10, type: 'click', target: { role: 'button', name: 'Send' } },
    ]);
    assert.deepEqual(store.ingest(b), { stored: 2, duplicate: 0, invalid: 0, capped: false });
    assert.deepEqual(store.ingest(b), { stored: 0, duplicate: 2, invalid: 0, capped: false });
    assert.equal(events(store).length, 2);
    const session = store.db.prepare('SELECT event_count FROM sessions').get() as { event_count: number };
    assert.equal(session.event_count, 2);
  });
});

test('never stores input values, nav titles, unknown keys or raw user agents', () => {
  withStore((store) => {
    store.ingest(
      batch([
        {
          seq: 0, t: 0, type: 'input', path: '/session/x',
          target: { role: 'textbox', name: 'Message', evil: 'drop me' },
          data: { kind: 'textarea', length: 42, value: 'MY SECRET PROMPT', text: 'MY SECRET PROMPT' },
        },
        { seq: 1, t: 1, type: 'nav', data: { kind: 'load', title: 'secret-project - CloudCLI UI' } },
        { seq: 2, t: 2, type: 'submit', data: { value: 'MY SECRET PROMPT' } },
        { seq: 3, t: 3, type: 'click', data: { x: 10, y: 20, innerText: 'MY SECRET PROMPT' } },
      ]),
      { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148' },
    );
    const dump = JSON.stringify(store.db.prepare('SELECT * FROM events').all())
      + JSON.stringify(store.db.prepare('SELECT * FROM sessions').all());
    assert.ok(!dump.includes('SECRET'), dump);
    assert.ok(!dump.includes('drop me'), dump);
    assert.ok(!dump.includes('iPhone OS'), dump);
    const rows = events(store);
    assert.deepEqual(JSON.parse(rows[0].data!), { kind: 'textarea', length: 42 });
    assert.deepEqual(JSON.parse(rows[0].target!), { name: 'Message', role: 'textbox' });
    assert.deepEqual(JSON.parse(rows[1].data!), { kind: 'load' });
    assert.equal(rows[2].data, null);
    const session = store.db.prepare('SELECT ua_class, viewport_w FROM sessions').get();
    assert.deepEqual({ ...(session as object) }, { ua_class: 'mobile', viewport_w: 390 });
  });
});

test('caps string lengths and events per session', () => {
  withStore((store) => {
    store.ingest(batch([{ seq: 0, t: 0, type: 'error', path: 'p'.repeat(500), data: { message: 'm'.repeat(999) } }]));
    const [row] = events(store);
    assert.equal(row.path!.length, MAX_STR);
    assert.equal(JSON.parse(row.data!).message.length, MAX_STR);

    store.db.prepare('UPDATE sessions SET event_count = ?').run(MAX_EVENTS_PER_SESSION - 1);
    const result = store.ingest(batch([
      { seq: 1, t: 1, type: 'click' },
      { seq: 2, t: 2, type: 'click' },
    ]));
    assert.deepEqual(result, { stored: 1, duplicate: 0, invalid: 0, capped: true });
  });
});

test('uaClass reduces the user agent to a coarse device class', () => {
  assert.equal(uaClass('Mozilla/5.0 (iPad; CPU OS 17_0)', 1024), 'tablet');
  assert.equal(uaClass('Mozilla/5.0 (Linux; Android 14) Mobile', 400), 'mobile');
  assert.equal(uaClass('Mozilla/5.0 (X11; Linux x86_64)', 1440), 'desktop');
  assert.equal(uaClass(undefined, 500), 'mobile');
  assert.equal(uaClass(null, 800), 'tablet');
  assert.equal(uaClass('', null), 'desktop');
});

test('prune drops sessions not seen within the window, cascading their events', () => {
  withStore((store) => {
    store.ingest(batch([{ seq: 0, t: 0, type: 'click' }]));
    store.ingest(batch([{ seq: 0, t: 0, type: 'click' }], { session_id: 'oldsession01' }));
    store.db.prepare("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00+00:00' WHERE id = 'oldsession01'").run();
    assert.equal(store.prune(30), 1);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 1);
  });
});

test('flowstore.py reads the db this port writes (skipped without python3)', (t) => {
  const probe = spawnSync('python3', ['--version']);
  if (probe.status !== 0) {
    t.skip('python3 not available');
    return;
  }
  withStore((store, dbPath) => {
    store.ingest(batch([
      { seq: 0, t: 0, type: 'nav', path: '/', data: { kind: 'load' } },
      { seq: 1, t: 5, type: 'click', target: { role: 'button', name: 'New conversation' } },
      { seq: 2, t: 9, type: 'nav', path: '/session/abc', data: { kind: 'pushState' } },
    ]));
    const stats = spawnSync('python3', [FLOWSTORE_PY, 'stats', '--db', dbPath], { encoding: 'utf8' });
    assert.equal(stats.status, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout).by_device, { mobile: 1 });
    const mined = spawnSync('python3', [FLOWSTORE_PY, 'mine', '--db', dbPath, '--min-sessions', '1'], {
      encoding: 'utf8',
    });
    assert.equal(mined.status, 0, mined.stderr);
    assert.deepEqual(JSON.parse(mined.stdout)[0].signature, [
      'visit /', 'click New conversation', 'visit /session/abc',
    ]);
  });
});

test('public/vd-recorder.js parses, and never reads document.title or input values', async () => {
  const { Script } = await import('node:vm');
  const source = readFileSync(path.join(REPO_ROOT, 'public', 'vd-recorder.js'), 'utf8');
  assert.doesNotThrow(() => new Script(source, { filename: 'vd-recorder.js' }));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!code.includes('document.title'), 'nav events must not carry the tab title');
  // The only `.value` read is the opt-in data-vd-capture-value branch and the length count.
  assert.match(code, /length: \(el\.value \|\| ""\)\.length/);
  assert.match(code, /hasAttribute\("data-vd-capture-value"\)/);
});
