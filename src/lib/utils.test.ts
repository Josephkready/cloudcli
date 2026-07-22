import assert from 'node:assert/strict';
import test from 'node:test';

import { cn, safeJsonParse } from './utils.js';

// safeJsonParse is the defensive JSON reader used across the app (e.g. parsing
// stored tool inputs); cn is the Tailwind class merger. Both must never throw.

test('safeJsonParse returns the parsed value for valid JSON', () => {
  assert.deepEqual(safeJsonParse('{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] });
  assert.equal(safeJsonParse('42'), 42);
  assert.equal(safeJsonParse('"hi"'), 'hi');
});

test('safeJsonParse returns null for malformed JSON instead of throwing', () => {
  assert.equal(safeJsonParse('{not json'), null);
  assert.equal(safeJsonParse('[1, 2,'), null);
});

test('safeJsonParse returns null for non-string / empty input', () => {
  assert.equal(safeJsonParse(null), null);
  assert.equal(safeJsonParse(undefined), null);
  assert.equal(safeJsonParse(''), null);
  assert.equal(safeJsonParse(123), null);
  assert.equal(safeJsonParse({ already: 'object' }), null);
});

test('cn joins truthy class names and drops falsy ones', () => {
  assert.equal(cn('a', false, undefined, null, 'c'), 'a c');
});

test('cn lets later Tailwind utilities win over conflicting earlier ones', () => {
  // twMerge resolves conflicts: the last padding utility should survive.
  assert.equal(cn('p-2', 'p-4'), 'p-4');
  assert.equal(cn('text-sm text-red-500', 'text-lg'), 'text-red-500 text-lg');
});
