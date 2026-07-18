import assert from 'node:assert/strict';
import test from 'node:test';

import { isSpawnRaceError, resolveToolApproval, waitForToolApproval } from './claude-sdk.js';

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

test('classifies a spawn-time ENOENT by its code + syscall', () => {
  const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', syscall: 'spawn claude' });
  assert.equal(isSpawnRaceError(error), true);
});

test('does not classify an unrelated file-I/O ENOENT as a spawn race', () => {
  // A missing-file read is ENOENT too, but not the CLI bin vanishing; the
  // syscall discriminates so it never triggers a spawn retry.
  const error = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT', syscall: 'open' });
  assert.equal(isSpawnRaceError(error), false);
});

test('does not classify unrelated errors as a spawn race', () => {
  assert.equal(isSpawnRaceError(new Error('User denied tool use')), false);
  assert.equal(isSpawnRaceError(new TypeError('x is not a function')), false);
});

test('is false for null/undefined', () => {
  assert.equal(isSpawnRaceError(null), false);
  assert.equal(isSpawnRaceError(undefined), false);
});

// #62: a tool-approval prompt must not auto-deny mid-task. The default wait is
// now indefinite (terminal parity) — it only settles on an explicit decision,
// an abort, or a finite timeout that must be opted into via the env var.

test('waitForToolApproval auto-denies (resolves null) after a finite timeout', async () => {
  const decision = await waitForToolApproval('req-finite-timeout', { timeoutMs: 15 });
  assert.equal(decision, null, 'a positive timeout must resolve to null (deny)');
});

test('waitForToolApproval with timeoutMs 0 stays pending until explicitly resolved', async () => {
  const requestId = 'req-indefinite';
  const approval = waitForToolApproval(requestId, { timeoutMs: 0 });

  // Must NOT settle on its own within a generous window.
  const first = await Promise.race([
    approval.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 40)),
  ]);
  assert.equal(first, 'pending', 'timeoutMs 0 must not auto-deny');

  resolveToolApproval(requestId, { allow: true });
  assert.deepEqual(await approval, { allow: true });
});

test('the default approval wait is indefinite (no auto-deny) — #62', async () => {
  // No timeoutMs => TOOL_APPROVAL_TIMEOUT_MS, which now defaults to 0.
  const requestId = 'req-default';
  const approval = waitForToolApproval(requestId);

  const first = await Promise.race([
    approval.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 40)),
  ]);
  assert.equal(first, 'pending', 'the default must not auto-deny mid-task');

  resolveToolApproval(requestId, { allow: false, message: 'denied by user' });
  assert.deepEqual(await approval, { allow: false, message: 'denied by user' });
});
