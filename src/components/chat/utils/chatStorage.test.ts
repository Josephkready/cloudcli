import assert from 'node:assert/strict';
import test from 'node:test';

import { withGlobals, withLocalStorage } from '../../../test/nodeStubs';

import {
  parseQueuedMessages,
  serializeQueuedMessages,
  safeLocalStorage,
  readQueuedMessages,
  writeQueuedMessages,
  getClaudeSettings,
  queuedMessageKey,
  CLAUDE_SETTINGS_KEY,
  type StoredQueuedMessage,
} from './chatStorage';

/* ── parseQueuedMessages: reading + migrating the persisted queue ────────── */

test('parse: null / empty / whitespace input yields an empty queue', () => {
  assert.deepEqual(parseQueuedMessages(null), []);
  assert.deepEqual(parseQueuedMessages(''), []);
  assert.deepEqual(parseQueuedMessages('   '), []);
});

test('parse: reads the current JSON array format, preserving order and options', () => {
  const raw = JSON.stringify([
    { content: 'first', options: { model: 'a' } },
    { content: 'second' },
    { content: 'third', options: { model: 'b' } },
  ]);
  assert.deepEqual(parseQueuedMessages(raw), [
    { content: 'first', options: { model: 'a' } },
    { content: 'second' },
    { content: 'third', options: { model: 'b' } },
  ]);
});

test('parse: migrates a legacy single object into a one-item queue', () => {
  const raw = JSON.stringify({ content: 'only', options: { model: 'x' } });
  assert.deepEqual(parseQueuedMessages(raw), [{ content: 'only', options: { model: 'x' } }]);
});

test('parse: migrates legacy raw text (non-JSON) into a one-item queue', () => {
  assert.deepEqual(parseQueuedMessages('just some text'), [{ content: 'just some text' }]);
});

test('parse: a bare JSON value that is not a message falls back to legacy raw text', () => {
  // Valid JSON, but not a {content} object/array — treat the raw string as text.
  assert.deepEqual(parseQueuedMessages('42'), [{ content: '42' }]);
  assert.deepEqual(parseQueuedMessages('"hello"'), [{ content: '"hello"' }]);
});

test('parse: drops empty, whitespace-only, and malformed entries from an array', () => {
  const raw = JSON.stringify([
    { content: 'keep' },
    { content: '   ' },
    { content: '' },
    { notContent: 'nope' },
    null,
    42,
    ['nested'],
    { content: 'also-keep', options: { a: 1 } },
  ]);
  assert.deepEqual(parseQueuedMessages(raw), [
    { content: 'keep' },
    { content: 'also-keep', options: { a: 1 } },
  ]);
});

test('parse: a legacy object with empty content yields an empty queue', () => {
  assert.deepEqual(parseQueuedMessages(JSON.stringify({ content: '   ' })), []);
});

/* ── serializeQueuedMessages: writing the queue ─────────────────────────── */

test('serialize: an empty queue returns null (signals key removal)', () => {
  assert.equal(serializeQueuedMessages([]), null);
});

test('serialize: a queue of only-empty entries returns null', () => {
  assert.equal(serializeQueuedMessages([{ content: '' }, { content: '  ' }]), null);
});

test('serialize: drops empty entries and omits an undefined options key', () => {
  const serialized = serializeQueuedMessages([
    { content: 'a', options: { model: 'm' } },
    { content: '   ' },
    { content: 'b' },
  ]);
  assert.equal(serialized, JSON.stringify([{ content: 'a', options: { model: 'm' } }, { content: 'b' }]));
});

/* ── round-trip: FIFO order and options survive a write→read cycle ───────── */

test('round-trip: parse(serialize(list)) preserves FIFO order and cleans empties', () => {
  const list: StoredQueuedMessage[] = [
    { content: 'one', options: { model: 'a' } },
    { content: '' }, // dropped
    { content: 'two' },
    { content: 'three', options: { effort: 'high' } },
  ];
  const serialized = serializeQueuedMessages(list);
  assert.notEqual(serialized, null);
  assert.deepEqual(parseQueuedMessages(serialized), [
    { content: 'one', options: { model: 'a' } },
    { content: 'two' },
    { content: 'three', options: { effort: 'high' } },
  ]);
});

/* ── safeLocalStorage: the storage wrapper that never throws ─────────────── */

test('safeLocalStorage get/set/remove round-trip through the backing store', () => {
  withLocalStorage({}, (store) => {
    safeLocalStorage.setItem('k', 'v');
    assert.equal(store.getItem('k'), 'v');
    assert.equal(safeLocalStorage.getItem('k'), 'v');
    assert.equal(safeLocalStorage.getItem('missing'), null);
    safeLocalStorage.removeItem('k');
    assert.equal(safeLocalStorage.getItem('k'), null);
  });
});

test('safeLocalStorage.setItem evicts draft/queued keys and retries on QuotaExceededError', () => {
  const kept = new Map<string, string>([
    ['draft_input_s1', 'old draft'],
    ['queued_message_s2', 'old queue'],
    ['keepme', 'important'],
  ]);
  let failNextSet = true;
  const quotaStore = {
    getItem: (k: string) => (kept.has(k) ? (kept.get(k) as string) : null),
    removeItem: (k: string) => { kept.delete(k); },
    setItem: (k: string, v: string) => {
      if (failNextSet) {
        failNextSet = false;
        const err = new Error('quota');
        err.name = 'QuotaExceededError';
        throw err;
      }
      kept.set(k, v);
    },
  };
  // `safeLocalStorage` reads `Object.keys(localStorage)` during cleanup, so the
  // stub must expose its entries as own enumerable properties too.
  for (const [k, v] of kept) {
    Object.defineProperty(quotaStore, k, { value: v, enumerable: true, configurable: true });
  }

  withGlobals({ localStorage: quotaStore }, () => {
    safeLocalStorage.setItem('claude-settings', '{"x":1}');
  });

  // The retry succeeded, the disposable draft/queue keys were purged, and the
  // unrelated key survived.
  assert.equal(kept.get('claude-settings'), '{"x":1}');
  assert.equal(kept.has('draft_input_s1'), false);
  assert.equal(kept.has('queued_message_s2'), false);
  assert.equal(kept.get('keepme'), 'important');
});

// The defensive wrapper logs caught errors via console.error; silence it here
// (the assertion is the swallowed throw + return value, not the log).
const silentConsole = { ...console, error: () => {}, warn: () => {} };

test('safeLocalStorage.getItem swallows a throwing store and returns null', () => {
  const throwingStore = {
    getItem: () => {
      throw new Error('SecurityError');
    },
  };
  withGlobals({ localStorage: throwingStore, console: silentConsole }, () => {
    assert.equal(safeLocalStorage.getItem('anything'), null);
  });
});

test('safeLocalStorage.setItem swallows a non-quota error without throwing', () => {
  const throwingStore = {
    setItem: () => {
      throw new Error('generic failure');
    },
  };
  withGlobals({ localStorage: throwingStore, console: silentConsole }, () => {
    assert.doesNotThrow(() => safeLocalStorage.setItem('k', 'v'));
  });
});

/* ── readQueuedMessages / writeQueuedMessages: storage-backed queue I/O ───── */

test('write then read a queue round-trips through the session-scoped key', () => {
  withLocalStorage({}, (store) => {
    writeQueuedMessages('sess-9', [{ content: 'hello', options: { model: 'm' } }, { content: 'world' }]);
    assert.equal(typeof store.getItem(queuedMessageKey('sess-9')), 'string');
    assert.deepEqual(readQueuedMessages('sess-9'), [
      { content: 'hello', options: { model: 'm' } },
      { content: 'world' },
    ]);
  });
});

test('writeQueuedMessages removes the key when the queue serializes to nothing', () => {
  withLocalStorage({ [queuedMessageKey('sess-9')]: 'stale' }, (store) => {
    writeQueuedMessages('sess-9', [{ content: '   ' }]);
    assert.equal(store.getItem(queuedMessageKey('sess-9')), null);
  });
});

test('readQueuedMessages migrates a legacy raw-text draft on read', () => {
  withLocalStorage({ [queuedMessageKey('sess-legacy')]: 'unsent draft text' }, () => {
    assert.deepEqual(readQueuedMessages('sess-legacy'), [{ content: 'unsent draft text' }]);
  });
});

/* ── getClaudeSettings: defensive settings read ──────────────────────────── */

test('getClaudeSettings returns hardened defaults when nothing is stored', () => {
  withLocalStorage({}, () => {
    assert.deepEqual(getClaudeSettings(), {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'count',
    });
  });
});

test('getClaudeSettings coerces malformed field types while preserving extras', () => {
  const raw = JSON.stringify({
    allowedTools: 'not-an-array',
    disallowedTools: ['Bash'],
    skipPermissions: 'yes',
    theme: 'dark',
  });
  withLocalStorage({ [CLAUDE_SETTINGS_KEY]: raw }, () => {
    const settings = getClaudeSettings();
    assert.deepEqual(settings.allowedTools, []); // non-array coerced to []
    assert.deepEqual(settings.disallowedTools, ['Bash']);
    assert.equal(settings.skipPermissions, true); // Boolean('yes')
    assert.equal(settings.projectSortOrder, 'count'); // absent -> default
    assert.equal(settings.theme, 'dark'); // unknown keys passed through
  });
});

test('getClaudeSettings falls back to count-order defaults on corrupt JSON', () => {
  // Regression: this branch used to default projectSortOrder to 'name',
  // disagreeing with the empty-store and valid-store defaults ('count').
  withLocalStorage({ [CLAUDE_SETTINGS_KEY]: '{ corrupt json' }, () => {
    assert.deepEqual(getClaudeSettings(), {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'count',
    });
  });
});
