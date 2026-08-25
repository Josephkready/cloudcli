import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLoginHandler,
  createLoginThrottleLogger,
  readLoginClientAddress,
} from './auth.js';
import { LoginAttemptLimiter } from './login-attempt-limiter.js';

type TestResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): TestResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): TestResponse;
};

function createResponse(): TestResponse {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('reads only the direct peer address, not a spoofable forwarding header', () => {
  assert.equal(readLoginClientAddress({
    headers: { 'x-forwarded-for': '203.0.113.10' },
    socket: { remoteAddress: '127.0.0.1' },
  }), '127.0.0.1');
  assert.equal(readLoginClientAddress({ socket: {} }), '<unknown>');
});

test('a blocked login returns 429 and Retry-After without touching bcrypt or the user database', async () => {
  let userLookups = 0;
  let passwordChecks = 0;
  const limiterInputs: unknown[][] = [];
  const limitedReasons: string[] = [];
  const limiter = {
    beginAttempt: (...args: unknown[]) => {
      limiterInputs.push(args);
      return { allowed: false, retryAfterSeconds: 12, reason: 'ip' };
    },
  };
  const handler = createLoginHandler({
    limiter,
    users: { getUserByUsername: () => { userLookups += 1; } },
    comparePassword: async () => { passwordChecks += 1; return false; },
    onRateLimited: (reason: string) => limitedReasons.push(reason),
  });
  const response = createResponse();

  await handler({
    body: { username: 'alice', password: 'wrong' },
    socket: { remoteAddress: '127.0.0.1' },
  }, response);

  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['Retry-After'], '12');
  assert.deepEqual(response.body, { error: 'Too many login attempts. Try again later.' });
  assert.equal(userLookups, 0);
  assert.equal(passwordChecks, 0);
  assert.deepEqual(limiterInputs, [['127.0.0.1', 'alice']]);
  assert.deepEqual(limitedReasons, ['ip']);
});

test('unknown users and bad passwords record failures with the same public error', async () => {
  const failedAttempts: number[] = [];
  let nextAttemptId = 40;
  const limiter = {
    beginAttempt: () => ({ allowed: true, attemptId: nextAttemptId += 1 }),
    recordFailure: (attemptId: number) => failedAttempts.push(attemptId),
  };
  const unknownHandler = createLoginHandler({
    limiter,
    users: { getUserByUsername: () => null },
    comparePassword: async () => { throw new Error('must not compare'); },
  });
  const unknownResponse = createResponse();
  await unknownHandler({ body: { username: 'unknown', password: 'wrong' }, socket: {} }, unknownResponse);

  const badPasswordHandler = createLoginHandler({
    limiter,
    users: { getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }) },
    comparePassword: async () => false,
  });
  const badPasswordResponse = createResponse();
  await badPasswordHandler({ body: { username: 'alice', password: 'wrong' }, socket: {} }, badPasswordResponse);

  assert.equal(unknownResponse.statusCode, 401);
  assert.equal(badPasswordResponse.statusCode, 401);
  assert.deepEqual(unknownResponse.body, { error: 'Invalid username or password' });
  assert.deepEqual(badPasswordResponse.body, unknownResponse.body);
  assert.deepEqual(failedAttempts, [41, 42]);
});

test('a successful login clears failures, updates last login, and returns the token', async () => {
  const events: string[] = [];
  const user = { id: 7, username: 'alice', password_hash: 'hash' };
  const handler = createLoginHandler({
    limiter: {
      beginAttempt: () => ({ allowed: true, attemptId: 73 }),
      recordSuccess: (attemptId: number) => events.push(`success:${attemptId}`),
    },
    users: {
      getUserByUsername: () => user,
      updateLastLogin: (id: number) => events.push(`updated:${id}`),
    },
    comparePassword: async () => true,
    createToken: () => 'signed-token',
  });
  const response = createResponse();

  await handler({ body: { username: 'alice', password: 'correct' }, socket: {} }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    success: true,
    user: { id: 7, username: 'alice' },
    token: 'signed-token',
  });
  assert.deepEqual(events, ['success:73', 'updated:7']);
});

test('an internal error releases the username guard for a retry', async (t) => {
  const cancelled: number[] = [];
  const limiter = {
    beginAttempt: () => ({ allowed: true, attemptId: 88 }),
    cancelAttempt: (attemptId: number) => cancelled.push(attemptId),
  };
  const handler = createLoginHandler({
    limiter,
    users: { getUserByUsername: () => { throw new Error('database unavailable'); } },
  });
  const response = createResponse();
  t.mock.method(console, 'error', () => {});

  await handler({ body: { username: 'alice', password: 'secret' }, socket: {} }, response);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(cancelled, [88]);
});

test('repeated failures through the real limiter short-circuit the next bcrypt check', async () => {
  let now = 100;
  let userLookups = 0;
  let passwordChecks = 0;
  const limiter = new LoginAttemptLimiter({
    clock: () => now,
    ipMaxAttempts: 100,
    backoffBaseMs: 1_000,
  });
  const handler = createLoginHandler({
    limiter,
    users: {
      getUserByUsername: () => {
        userLookups += 1;
        return { id: 1, username: 'alice', password_hash: 'hash' };
      },
    },
    comparePassword: async () => {
      passwordChecks += 1;
      return false;
    },
    onRateLimited: () => {},
  });

  const firstResponse = createResponse();
  await handler({
    body: { username: 'alice', password: 'wrong' },
    socket: { remoteAddress: '127.0.0.1' },
  }, firstResponse);
  const blockedResponse = createResponse();
  await handler({
    body: { username: 'alice', password: 'wrong-again' },
    socket: { remoteAddress: '127.0.0.1' },
  }, blockedResponse);

  assert.equal(firstResponse.statusCode, 401);
  assert.equal(blockedResponse.statusCode, 429);
  assert.equal(blockedResponse.headers['Retry-After'], '1');
  assert.equal(userLookups, 1);
  assert.equal(passwordChecks, 1);

  now = 1_100;
  const retryResponse = createResponse();
  await handler({
    body: { username: 'alice', password: 'still-wrong' },
    socket: { remoteAddress: '127.0.0.1' },
  }, retryResponse);
  assert.equal(retryResponse.statusCode, 401);
  assert.equal(userLookups, 2);
  assert.equal(passwordChecks, 2);
});

test('throttle logging emits one metadata-only warning per minute and reports suppression', () => {
  let now = 0;
  const warnings: unknown[][] = [];
  const log = createLoginThrottleLogger({
    clock: () => now,
    warn: (...args: unknown[]) => warnings.push(args),
  });

  log('ip');
  log('username');
  now = 60_000;
  log('username');

  assert.deepEqual(warnings, [
    ['[Auth] Login attempts rate limited', { reason: 'ip', suppressed: 0 }],
    ['[Auth] Login attempts rate limited', { reason: 'username', suppressed: 1 }],
  ]);
});
