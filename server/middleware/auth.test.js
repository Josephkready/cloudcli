import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apiKeysMatch,
  createAuthenticateToken,
  createAuthenticateWebSocket,
  generateToken,
  readRequestBearerToken,
  tokenVersionMatches,
} from './auth.js';

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

test('apiKeysMatch accepts only the exact configured API key', () => {
  assert.equal(apiKeysMatch('correct-key', 'correct-key'), true);
  assert.equal(apiKeysMatch('correct-kex', 'correct-key'), false);
  assert.equal(apiKeysMatch('correct-key-extra', 'correct-key'), false);
  assert.equal(apiKeysMatch(undefined, 'correct-key'), false);
  assert.equal(apiKeysMatch(['correct-key'], 'correct-key'), false);
  assert.equal(apiKeysMatch('', ''), false);
});

test('REST authentication reads bearer headers and ignores query-string tokens', () => {
  assert.equal(readRequestBearerToken({
    headers: { authorization: 'Bearer header-token' },
    query: { token: 'query-token' },
  }), 'header-token');
  assert.equal(readRequestBearerToken({
    headers: {},
    query: { token: 'query-token' },
  }), null);
});

test('token versions must be present, integral, and equal', () => {
  const user = { token_version: 3 };
  assert.equal(tokenVersionMatches({ tokenVersion: 3 }, user), true);
  assert.equal(tokenVersionMatches({ tokenVersion: 2 }, user), false);
  assert.equal(tokenVersionMatches({}, user), false);
  assert.equal(tokenVersionMatches({ tokenVersion: '3' }, user), false);
});

test('REST authentication rejects a JWT after its user token version advances', async () => {
  let user = { id: 1, username: 'alice', token_version: 0 };
  const token = generateToken(user);
  const authenticate = createAuthenticateToken({
    bypassAuth: false,
    users: { getUserById: () => user },
    onError: () => assert.fail('a valid signed token must not throw'),
  });
  const request = { headers: { authorization: `Bearer ${token}` } };
  const acceptedResponse = createResponse();
  let nextCalls = 0;

  await authenticate(request, acceptedResponse, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(request.user.username, 'alice');

  user = { ...user, token_version: 1 };
  const revokedResponse = createResponse();
  await authenticate(
    { headers: { authorization: `Bearer ${token}` } },
    revokedResponse,
    () => { nextCalls += 1; },
  );

  assert.equal(revokedResponse.statusCode, 401);
  assert.deepEqual(revokedResponse.body, { error: 'Invalid or revoked token' });
  assert.equal(nextCalls, 1);
});

test('REST authentication rejects pre-migration JWTs without a token version', async () => {
  const response = createResponse();
  let nextCalls = 0;
  const authenticate = createAuthenticateToken({
    bypassAuth: false,
    verifyToken: () => ({ userId: 1, iat: 100, exp: 200 }),
    users: { getUserById: () => ({ id: 1, username: 'alice', token_version: 0 }) },
  });

  await authenticate(
    { headers: { authorization: 'Bearer legacy-token' } },
    response,
    () => { nextCalls += 1; },
  );

  assert.equal(response.statusCode, 401);
  assert.equal(nextCalls, 0);
  assert.deepEqual(response.headers, {});
});

test('REST refresh preserves the current token version and never refreshes a stale token', async () => {
  const user = { id: 1, username: 'alice', token_version: 4 };
  const createdFor = [];
  const authenticate = createAuthenticateToken({
    bypassAuth: false,
    clock: () => 180_000,
    users: { getUserById: () => user },
    verifyToken: () => ({ userId: 1, tokenVersion: 4, iat: 100, exp: 200 }),
    createToken: (currentUser) => {
      createdFor.push(currentUser.token_version);
      return 'refreshed-token';
    },
  });
  const response = createResponse();

  await authenticate(
    { headers: { authorization: 'Bearer current-token' } },
    response,
    () => {},
  );
  assert.equal(response.headers['X-Refreshed-Token'], 'refreshed-token');
  assert.deepEqual(createdFor, [4]);

  const staleResponse = createResponse();
  const staleAuthenticate = createAuthenticateToken({
    bypassAuth: false,
    clock: () => 180_000,
    users: { getUserById: () => ({ ...user, token_version: 5 }) },
    verifyToken: () => ({ userId: 1, tokenVersion: 4, iat: 100, exp: 200 }),
    createToken: () => assert.fail('stale tokens must not refresh'),
  });
  await staleAuthenticate(
    { headers: { authorization: 'Bearer stale-token' } },
    staleResponse,
    () => assert.fail('stale tokens must not reach the route'),
  );
  assert.deepEqual(staleResponse.headers, {});
  assert.equal(staleResponse.statusCode, 401);
});

test('WebSocket authentication rejects the same JWT after revocation', () => {
  let user = { id: 1, username: 'alice', token_version: 7 };
  const token = generateToken(user);
  const authenticate = createAuthenticateWebSocket({
    bypassAuth: false,
    users: { getUserById: () => user },
    onError: () => assert.fail('a valid signed token must not throw'),
  });

  assert.deepEqual(authenticate(token), { userId: 1, username: 'alice' });
  user = { ...user, token_version: 8 };
  assert.equal(authenticate(token), null);
});
