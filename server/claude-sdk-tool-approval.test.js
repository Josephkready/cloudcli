import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvalTimeoutForTool,
  denyResultForDecision,
  resolveToolApproval,
  waitForToolApproval,
} from './claude-sdk.js';

/*
 * Regression lock for #62 — tool-approval timeout semantics.
 *
 * `claude-sdk.test.js` already pins the core of `waitForToolApproval` (finite
 * timeout → null, timeoutMs:0 / default → indefinite). This file pins the
 * `canUseTool` branch that consumes those results: which timeout an interactive
 * vs. non-interactive tool waits on, how a settled decision maps to a permission
 * result, and the abort / cancel paths that back the `permission_cancelled`
 * emission. (#86's stale-approval reaper is tested separately — not re-covered.)
 */

/* ── approvalTimeoutForTool: interactive tools never auto-deny ─────────────── */

test('interactive tools (ExitPlanMode / AskUserQuestion) wait indefinitely (timeout 0)', () => {
  // The whole point of #62: a plan-approval or question prompt must never be
  // silently auto-denied mid-task. timeout 0 => wait forever.
  assert.equal(approvalTimeoutForTool('ExitPlanMode'), 0);
  assert.equal(approvalTimeoutForTool('AskUserQuestion'), 0);
});

test('non-interactive tools defer to the configured default timeout (undefined)', () => {
  // undefined => waitForToolApproval falls back to TOOL_APPROVAL_TIMEOUT_MS
  // (itself 0 unless CLAUDE_TOOL_APPROVAL_TIMEOUT_MS is set).
  assert.equal(approvalTimeoutForTool('Bash'), undefined);
  assert.equal(approvalTimeoutForTool('Read'), undefined);
  assert.equal(approvalTimeoutForTool('SomeMcpTool'), undefined);
});

/* ── denyResultForDecision: the canUseTool deny mapping ────────────────────── */

test('a null decision (finite-timeout auto-deny) maps to the timeout deny message', () => {
  assert.deepEqual(denyResultForDecision(null), {
    behavior: 'deny',
    message: 'Permission request timed out',
  });
});

test('a cancelled decision (abort / interrupt) maps to the cancel deny message', () => {
  assert.deepEqual(denyResultForDecision({ cancelled: true }), {
    behavior: 'deny',
    message: 'Permission request cancelled',
  });
});

test('a user denial preserves the user message, falling back to a default', () => {
  assert.deepEqual(denyResultForDecision({ allow: false, message: 'nope, not that file' }), {
    behavior: 'deny',
    message: 'nope, not that file',
  });
  assert.deepEqual(denyResultForDecision({ allow: false }), {
    behavior: 'deny',
    message: 'User denied tool use',
  });
});

/* ── waitForToolApproval: abort / cancel wiring behind permission_cancelled ── */

test('an already-aborted signal resolves cancelled immediately and fires onCancel', async () => {
  const reasons = [];
  const controller = new AbortController();
  controller.abort();

  const decision = await waitForToolApproval('req-pre-aborted', {
    signal: controller.signal,
    onCancel: (reason) => reasons.push(reason),
  });

  assert.deepEqual(decision, { cancelled: true });
  assert.deepEqual(reasons, ['cancelled']);
});

test('aborting mid-wait resolves cancelled and fires onCancel("cancelled")', async () => {
  const reasons = [];
  const controller = new AbortController();
  const approval = waitForToolApproval('req-mid-abort', {
    timeoutMs: 0,
    signal: controller.signal,
    onCancel: (reason) => reasons.push(reason),
  });

  controller.abort();

  assert.deepEqual(await approval, { cancelled: true });
  assert.deepEqual(reasons, ['cancelled']);
});

test('a finite timeout fires onCancel("timeout") before auto-denying (null)', async () => {
  const reasons = [];
  const decision = await waitForToolApproval('req-timeout-cb', {
    timeoutMs: 15,
    onCancel: (reason) => reasons.push(reason),
  });

  assert.equal(decision, null, 'a finite timeout auto-denies with null');
  assert.deepEqual(reasons, ['timeout'], 'onCancel drives the permission_cancelled emission');
});

test('an explicit resolve wins over a pending indefinite wait and clears the entry', async () => {
  const requestId = 'req-explicit';
  const approval = waitForToolApproval(requestId, { timeoutMs: 0 });

  resolveToolApproval(requestId, { allow: true, updatedInput: { command: 'ls' } });
  assert.deepEqual(await approval, { allow: true, updatedInput: { command: 'ls' } });

  // The entry is removed on settle, so a second resolve is an inert no-op
  // (it must not throw or re-settle the already-resolved promise).
  assert.doesNotThrow(() => resolveToolApproval(requestId, { allow: false }));
});
