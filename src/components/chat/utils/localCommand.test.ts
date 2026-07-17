import assert from 'node:assert/strict';
import test from 'node:test';

import { formatLocalCommandLabel } from './localCommand';

test('uses the slash-prefixed commandName', () => {
  assert.equal(formatLocalCommandLabel({ commandName: '/usage' }), '/usage');
});

test('appends commandArgs to the command name', () => {
  assert.equal(
    formatLocalCommandLabel({ commandName: '/model', commandArgs: 'opus' }),
    '/model opus',
  );
});

test('does not append blank/whitespace args', () => {
  assert.equal(formatLocalCommandLabel({ commandName: '/clear', commandArgs: '   ' }), '/clear');
});

test('falls back to commandMessage, adding a leading slash', () => {
  assert.equal(formatLocalCommandLabel({ commandMessage: 'usage' }), '/usage');
  // Already-slashed message is not double-slashed.
  assert.equal(formatLocalCommandLabel({ commandMessage: '/usage' }), '/usage');
});

test('normalizes to exactly one leading slash regardless of field or slashes', () => {
  // An unslashed commandName gets a slash...
  assert.equal(formatLocalCommandLabel({ commandName: 'usage' }), '/usage');
  // ...and multiple leading slashes collapse to one, from either field.
  assert.equal(formatLocalCommandLabel({ commandName: '//usage' }), '/usage');
  assert.equal(formatLocalCommandLabel({ commandMessage: '//usage' }), '/usage');
});

test('falls back to content when no structured command fields exist', () => {
  // content already includes args, so they are not re-appended here.
  assert.equal(
    formatLocalCommandLabel({ commandArgs: 'ignored', content: '/foo bar' }),
    '/foo bar',
  );
});

test('returns an empty string when nothing is available', () => {
  assert.equal(formatLocalCommandLabel({}), '');
  assert.equal(formatLocalCommandLabel({ content: '   ' }), '');
});
