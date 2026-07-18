import assert from 'node:assert/strict';
import test from 'node:test';

import { isSpawnRaceError } from './claude-sdk.js';

// The spawn-retry (#43) hinges on classifying the transient "the `claude` bin
// briefly vanished" errors apart from genuine failures. Only the former may be
// retried.

test('classifies the SDK native-binary-not-found message as a spawn race', () => {
  const error = new ReferenceError(
    'Claude Code native binary not found at claude. Please ensure Claude Code is installed '
    + 'via native installer or specify a valid path with options.pathToClaudeCodeExecutable.',
  );
  assert.equal(isSpawnRaceError(error), true);
});

test('classifies an ENOENT spawn error by its code', () => {
  const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  assert.equal(isSpawnRaceError(error), true);
});

test('classifies an ENOENT mentioned only in the message', () => {
  assert.equal(isSpawnRaceError(new Error('ENOENT: no such file or directory')), true);
});

test('does not classify unrelated errors as a spawn race', () => {
  assert.equal(isSpawnRaceError(new Error('User denied tool use')), false);
  assert.equal(isSpawnRaceError(new TypeError('x is not a function')), false);
});

test('is false for null/undefined', () => {
  assert.equal(isSpawnRaceError(null), false);
  assert.equal(isSpawnRaceError(undefined), false);
});
