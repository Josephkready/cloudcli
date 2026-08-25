import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type LoginAttemptDecision,
  LoginAttemptLimiter,
  normalizeLoginClientAddress,
  normalizeLoginUsername,
} from './login-attempt-limiter.js';

function allowedAttemptId(decision: LoginAttemptDecision): number {
  assert.equal(decision.allowed, true);
  if (!decision.allowed) throw new Error('Expected an allowed login attempt');
  return decision.attemptId;
}

test('normalizes limiter keys and caps attacker-controlled input length', () => {
  assert.equal(normalizeLoginUsername('  ALICE  '), 'alice');
  assert.equal(normalizeLoginUsername('ＡＬＩＣＥ'), 'alice');
  assert.equal(normalizeLoginUsername(''), '<empty>');
  assert.equal(normalizeLoginUsername('x'.repeat(300)).length, 256);
  assert.equal(normalizeLoginClientAddress('  127.0.0.1  '), '127.0.0.1');
  assert.equal(normalizeLoginClientAddress(''), '<unknown>');
  assert.equal(normalizeLoginClientAddress('x'.repeat(200)).length, 128);
});

test('per-IP budget rejects bursts before bcrypt work and resets after its window', () => {
  let now = 0;
  const limiter = new LoginAttemptLimiter({
    clock: () => now,
    ipMaxAttempts: 2,
    ipWindowMs: 1_000,
  });

  limiter.cancelAttempt(allowedAttemptId(limiter.beginAttempt('127.0.0.1', 'alice')));
  limiter.cancelAttempt(allowedAttemptId(limiter.beginAttempt('127.0.0.1', 'bob')));
  assert.deepEqual(limiter.beginAttempt('127.0.0.1', 'carol'), {
    allowed: false,
    retryAfterSeconds: 1,
    reason: 'ip',
  });

  now = 1_000;
  allowedAttemptId(limiter.beginAttempt('127.0.0.1', 'carol'));
});

test('serializes username checks, exponentially backs off failures, and locks after the threshold', () => {
  let now = 100;
  const limiter = new LoginAttemptLimiter({
    clock: () => now,
    ipMaxAttempts: 100,
    backoffBaseMs: 1_000,
    backoffMaxMs: 4_000,
    maxFailures: 3,
    lockoutMs: 10_000,
    inFlightMs: 10_000,
  });

  const firstAttempt = allowedAttemptId(limiter.beginAttempt('ip-1', ' Alice '));
  assert.deepEqual(limiter.beginAttempt('ip-2', 'alice'), {
    allowed: false,
    retryAfterSeconds: 10,
    reason: 'username',
  });

  limiter.recordFailure(firstAttempt);
  now = 1_099;
  assert.equal(limiter.beginAttempt('ip-2', 'alice').allowed, false);
  now = 1_100;
  const secondAttempt = allowedAttemptId(limiter.beginAttempt('ip-2', 'alice'));

  limiter.recordFailure(secondAttempt);
  now = 3_099;
  assert.equal(limiter.beginAttempt('ip-3', 'alice').allowed, false);
  now = 3_100;
  const thirdAttempt = allowedAttemptId(limiter.beginAttempt('ip-3', 'alice'));

  limiter.recordFailure(thirdAttempt);
  now = 13_099;
  assert.deepEqual(limiter.beginAttempt('ip-4', 'alice'), {
    allowed: false,
    retryAfterSeconds: 1,
    reason: 'username',
  });
  now = 13_100;
  const postLockoutAttempt = allowedAttemptId(limiter.beginAttempt('ip-4', 'alice'));

  limiter.recordFailure(postLockoutAttempt);
  now = 14_099;
  assert.equal(limiter.beginAttempt('ip-5', 'alice').allowed, false);
  now = 14_100;
  const successfulAttempt = allowedAttemptId(limiter.beginAttempt('ip-5', 'alice'));

  limiter.recordSuccess(successfulAttempt);
  allowedAttemptId(limiter.beginAttempt('ip-6', 'alice'));
});

test('failure history expires and an internal error releases the in-flight guard', () => {
  let now = 100;
  const limiter = new LoginAttemptLimiter({
    clock: () => now,
    ipMaxAttempts: 100,
    backoffBaseMs: 1_000,
    failureResetMs: 5_000,
    inFlightMs: 10_000,
  });

  const failedAttempt = allowedAttemptId(limiter.beginAttempt('ip-1', 'alice'));
  limiter.recordFailure(failedAttempt);
  now = 6_000;
  const cancelledAttempt = allowedAttemptId(limiter.beginAttempt('ip-2', 'alice'));
  limiter.cancelAttempt(cancelledAttempt);
  allowedAttemptId(limiter.beginAttempt('ip-3', 'alice'));
});

test('bounded overflow buckets fail secure without evicting an active account lockout', () => {
  let now = 100;
  const limiter = new LoginAttemptLimiter({
    clock: () => now,
    ipMaxAttempts: 100,
    maxEntries: 2,
    backoffBaseMs: 1_000,
  });

  limiter.recordFailure(allowedAttemptId(limiter.beginAttempt('ip-1', 'alice')));
  limiter.recordFailure(allowedAttemptId(limiter.beginAttempt('ip-2', 'bob')));

  assert.deepEqual(limiter.beginAttempt('ip-3', 'carol'), {
    allowed: false,
    retryAfterSeconds: 1,
    reason: 'username',
  });
  assert.deepEqual(limiter.beginAttempt('ip-4', 'alice'), {
    allowed: false,
    retryAfterSeconds: 1,
    reason: 'username',
  });

  now = 1_100;
  allowedAttemptId(limiter.beginAttempt('ip-5', 'alice'));
});

test('a stale failed completion cannot recreate backoff after a newer successful login', () => {
  let now = 100;
  const limiter = new LoginAttemptLimiter({
    clock: () => now,
    ipMaxAttempts: 100,
    inFlightMs: 1_000,
  });

  const staleAttempt = allowedAttemptId(limiter.beginAttempt('ip-1', 'alice'));
  now = 1_100;
  const newerAttempt = allowedAttemptId(limiter.beginAttempt('ip-2', 'alice'));
  limiter.recordSuccess(newerAttempt);
  limiter.recordFailure(staleAttempt);

  allowedAttemptId(limiter.beginAttempt('ip-3', 'alice'));
});
