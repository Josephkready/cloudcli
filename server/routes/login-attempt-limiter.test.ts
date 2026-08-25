import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LoginAttemptLimiter,
  normalizeLoginClientAddress,
  normalizeLoginUsername,
} from './login-attempt-limiter.js';

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

  assert.deepEqual(limiter.beginAttempt('127.0.0.1', 'alice'), { allowed: true });
  limiter.cancelAttempt('alice');
  assert.deepEqual(limiter.beginAttempt('127.0.0.1', 'bob'), { allowed: true });
  limiter.cancelAttempt('bob');
  assert.deepEqual(limiter.beginAttempt('127.0.0.1', 'carol'), {
    allowed: false,
    retryAfterSeconds: 1,
    reason: 'ip',
  });

  now = 1_000;
  assert.deepEqual(limiter.beginAttempt('127.0.0.1', 'carol'), { allowed: true });
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

  assert.deepEqual(limiter.beginAttempt('ip-1', ' Alice '), { allowed: true });
  assert.deepEqual(limiter.beginAttempt('ip-2', 'alice'), {
    allowed: false,
    retryAfterSeconds: 10,
    reason: 'username',
  });

  limiter.recordFailure('ALICE');
  now = 1_099;
  assert.equal(limiter.beginAttempt('ip-2', 'alice').allowed, false);
  now = 1_100;
  assert.deepEqual(limiter.beginAttempt('ip-2', 'alice'), { allowed: true });

  limiter.recordFailure('alice');
  now = 3_099;
  assert.equal(limiter.beginAttempt('ip-3', 'alice').allowed, false);
  now = 3_100;
  assert.deepEqual(limiter.beginAttempt('ip-3', 'alice'), { allowed: true });

  limiter.recordFailure('alice');
  now = 13_099;
  assert.deepEqual(limiter.beginAttempt('ip-4', 'alice'), {
    allowed: false,
    retryAfterSeconds: 1,
    reason: 'username',
  });
  now = 13_100;
  assert.deepEqual(limiter.beginAttempt('ip-4', 'alice'), { allowed: true });

  limiter.recordFailure('alice');
  now = 14_099;
  assert.equal(limiter.beginAttempt('ip-5', 'alice').allowed, false);
  now = 14_100;
  assert.deepEqual(limiter.beginAttempt('ip-5', 'alice'), { allowed: true });

  limiter.recordSuccess('alice');
  assert.deepEqual(limiter.beginAttempt('ip-6', 'alice'), { allowed: true });
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

  assert.equal(limiter.beginAttempt('ip-1', 'alice').allowed, true);
  limiter.recordFailure('alice');
  now = 6_000;
  assert.equal(limiter.beginAttempt('ip-2', 'alice').allowed, true);
  limiter.cancelAttempt('alice');
  assert.equal(limiter.beginAttempt('ip-3', 'alice').allowed, true);
});

test('bounded overflow buckets fail secure without evicting an active account lockout', () => {
  let now = 100;
  const limiter = new LoginAttemptLimiter({
    clock: () => now,
    ipMaxAttempts: 100,
    maxEntries: 2,
    backoffBaseMs: 1_000,
  });

  assert.equal(limiter.beginAttempt('ip-1', 'alice').allowed, true);
  limiter.recordFailure('alice');
  assert.equal(limiter.beginAttempt('ip-2', 'bob').allowed, true);
  limiter.recordFailure('bob');

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
  assert.equal(limiter.beginAttempt('ip-5', 'alice').allowed, true);
});
