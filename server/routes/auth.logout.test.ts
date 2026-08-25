import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthenticateToken, generateToken } from '../middleware/auth.js';

import { createLogoutHandler } from './auth.js';

type TestResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): TestResponse;
  json(body: unknown): TestResponse;
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
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
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    removeHeader(name) {
      delete this.headers[name];
    },
  };
}

test('logout advances the persisted version and removes a just-refreshed token header', () => {
  const revokedUserIds: number[] = [];
  const disconnectedUserIds: number[] = [];
  const webSocketServer = { clients: new Set() };
  const handler = createLogoutHandler({
    users: {
      revokeTokens: (userId: number) => {
        revokedUserIds.push(userId);
        return true;
      },
    },
    closeUserWebSockets: (server: unknown, userId: number) => {
      assert.equal(server, webSocketServer);
      disconnectedUserIds.push(userId);
    },
  });
  const response = createResponse();
  response.headers['X-Refreshed-Token'] = 'now-stale';

  handler({
    user: { id: 9, username: 'alice' },
    app: { locals: { wss: webSocketServer } },
  }, response);

  assert.deepEqual(revokedUserIds, [9]);
  assert.deepEqual(disconnectedUserIds, [9]);
  assert.deepEqual(response.headers, {});
  assert.deepEqual(response.body, { success: true, message: 'Logged out successfully' });
});

test('a logout makes the same signed JWT fail the next REST authentication', async () => {
  let user = { id: 1, username: 'alice', token_version: 0 };
  const token = generateToken(user);
  const users = {
    getUserById: () => user,
    revokeTokens: (userId: number) => {
      if (userId !== user.id) return false;
      user = { ...user, token_version: user.token_version + 1 };
      return true;
    },
  };
  const authenticate = createAuthenticateToken({ bypassAuth: false, users });
  const logout = createLogoutHandler({ users });
  const request = { headers: { authorization: `Bearer ${token}` }, user: undefined };
  const logoutResponse = createResponse();

  await authenticate(request, logoutResponse, () => logout(request, logoutResponse));
  assert.equal(logoutResponse.statusCode, 200);
  assert.equal(user.token_version, 1);

  const retryResponse = createResponse();
  let nextCalls = 0;
  await authenticate(
    { headers: { authorization: `Bearer ${token}` } },
    retryResponse,
    () => { nextCalls += 1; },
  );
  assert.equal(retryResponse.statusCode, 401);
  assert.equal(nextCalls, 0);
});

test('logout reports a database failure without claiming revocation succeeded', (t) => {
  t.mock.method(console, 'error', () => {});
  const handler = createLogoutHandler({
    users: { revokeTokens: () => { throw new Error('database unavailable'); } },
  });
  const response = createResponse();

  handler({ user: { id: 1 } }, response);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: 'Internal server error' });
});
