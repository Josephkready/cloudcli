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

// The defensive wrapper logs caught errors via console.error/warn; silence it
// here (the assertions are the swallowed throw + return value, not the log).
const silentConsole = { ...console, error: () => {}, warn: () => {} };

test('safeLocalStorage get/set/remove round-trip through the backing store', () => {
  withLocalStorage({}, (store) => {
    assert.equal(safeLocalStorage.setItem('k', 'v'), true);
    assert.equal(store.getItem('k'), 'v');
    assert.equal(safeLocalStorage.getItem('k'), 'v');
    assert.equal(safeLocalStorage.getItem('missing'), null);
    safeLocalStorage.removeItem('k');
    assert.equal(safeLocalStorage.getItem('k'), null);
  });
});

/**
 * A store with a real byte budget: a write throws `QuotaExceededError` unless
 * it fits, and `removeItem` is the only thing that buys room. That makes the
 * question these tests exist to answer — which keys the recovery sweep is
 * willing to delete — decide whether the retry succeeds.
 */
function makeQuotaStore(seed: Record<string, string>, capBytes: number) {
  const kept = new Map<string, string>(Object.entries(seed));
  const size = (k: string, v: string) => k.length + v.length;
  const usedExcluding = (key: string) =>
    [...kept].reduce((total, [k, v]) => (k === key ? total : total + size(k, v)), 0);

  const api = {
    getItem: (k: string) => (kept.has(k) ? (kept.get(k) as string) : null),
    removeItem: (k: string) => {
      kept.delete(k);
    },
    setItem: (k: string, v: string) => {
      if (usedExcluding(k) + size(k, v) > capBytes) {
        const err = new Error('quota');
        err.name = 'QuotaExceededError';
        throw err;
      }
      kept.set(k, v);
    },
  };

  // `safeLocalStorage` enumerates the store with `Object.keys(localStorage)` to
  // find eviction candidates, so entries must read back as own enumerable
  // properties — and must disappear from that enumeration once removed.
  const store = new Proxy(api, {
    ownKeys: () => [...Reflect.ownKeys(api), ...kept.keys()],
    getOwnPropertyDescriptor: (target, prop) =>
      typeof prop === 'string' && kept.has(prop)
        ? { value: kept.get(prop), enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, prop),
    get: (target, prop) =>
      prop in target
        ? Reflect.get(target, prop)
        : typeof prop === 'string'
          ? kept.get(prop)
          : undefined,
  });

  return { store, kept };
}

test('quota recovery evicts drafts but never the messages the user queued (#330)', () => {
  // Drafts alone are worth ~40 bytes more than the headroom the new write
  // needs, so the retry can only succeed by evicting them.
  const { store, kept } = makeQuotaStore(
    {
      draft_input_projectA: 'a draft being typed elsewhere',
      draft_input_projectB: 'another project draft',
      queued_message_s2: '[{"content":"please refactor the parser"}]',
      pending_send_s3: '[{"content":"sent but unconfirmed"}]',
      keepme: 'important',
    },
    180,
  );

  let result: boolean | undefined;
  withGlobals({ localStorage: store, console: silentConsole }, () => {
    result = safeLocalStorage.setItem('claude-settings', '{"x":1}');
  });

  assert.equal(result, true);
  assert.equal(kept.get('claude-settings'), '{"x":1}');
  // Drafts are re-derivable from the composer's live input, so they pay.
  assert.equal(kept.has('draft_input_projectA'), false);
  assert.equal(kept.has('draft_input_projectB'), false);
  // These are the only durable copy of text the user wrote. #330 (queued) and
  // #327 (pending) both turn on them surviving.
  assert.equal(kept.get('queued_message_s2'), '[{"content":"please refactor the parser"}]');
  assert.equal(kept.get('pending_send_s3'), '[{"content":"sent but unconfirmed"}]');
  assert.equal(kept.get('keepme'), 'important');
});

test('a write that cannot be satisfied fails loudly instead of eating queued messages', () => {
  // The queue alone fills the budget: no amount of draft eviction makes room.
  const { store, kept } = makeQuotaStore(
    {
      draft_input_projectA: 'a draft',
      queued_message_s2: '[{"content":"the message that must not be dropped"}]',
    },
    70,
  );

  let result: boolean | undefined;
  withGlobals({ localStorage: store, console: silentConsole }, () => {
    result = safeLocalStorage.setItem('claude-settings', '{"x":1}');
  });

  // Reported as failed rather than swallowed, and the user's text is still here.
  assert.equal(result, false);
  assert.equal(kept.has('claude-settings'), false);
  assert.equal(kept.get('queued_message_s2'), '[{"content":"the message that must not be dropped"}]');
});

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
    // Doesn't throw, but doesn't claim to have stored anything either.
    assert.equal(safeLocalStorage.setItem('k', 'v'), false);
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
    // Clearing always leaves the queue durable — there is nothing left to lose.
    assert.equal(writeQueuedMessages('sess-9', [{ content: '   ' }]), true);
    assert.equal(store.getItem(queuedMessageKey('sess-9')), null);
  });
});

test('writeQueuedMessages reports whether the queue actually survived the write', () => {
  withLocalStorage({}, () => {
    assert.equal(writeQueuedMessages('sess-9', [{ content: 'hello' }]), true);
  });

  // A full store: the caller is told the queue is memory-only, which is what
  // lets the composer warn instead of losing the message on the next reload.
  const { store, kept } = makeQuotaStore({ queued_message_sess9: '[{"content":"older"}]' }, 25);
  let result: boolean | undefined;
  withGlobals({ localStorage: store, console: silentConsole }, () => {
    result = writeQueuedMessages('sess-9', [{ content: 'a much longer message' }]);
  });

  assert.equal(result, false);
  // A refused write leaves whatever was already stored untouched.
  assert.equal(kept.get('queued_message_sess9'), '[{"content":"older"}]');
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
