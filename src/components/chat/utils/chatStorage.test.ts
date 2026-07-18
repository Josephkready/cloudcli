import assert from 'node:assert/strict';
import test from 'node:test';

import { parseQueuedMessages, serializeQueuedMessages, type StoredQueuedMessage } from './chatStorage';

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
