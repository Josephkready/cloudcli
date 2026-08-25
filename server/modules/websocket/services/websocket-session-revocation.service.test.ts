import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebSocket, WebSocketServer } from 'ws';

import {
  closeWebSocketsForUser,
  tagAuthenticatedWebSocket,
} from './websocket-session-revocation.service.js';

type FakeSocket = {
  authenticatedUserId?: string | number;
  closeCalls: Array<[number, string]>;
  terminateCalls: number;
  close(code: number, reason: string): void;
  terminate(): void;
};

function createSocket(): FakeSocket {
  return {
    closeCalls: [],
    terminateCalls: 0,
    close(code, reason) {
      this.closeCalls.push([code, reason]);
    },
    terminate() {
      this.terminateCalls += 1;
    },
  };
}

test('authenticated sockets are tagged from either supported user-id field', () => {
  const fromUserId = createSocket();
  const fromId = createSocket();

  tagAuthenticatedWebSocket(fromUserId as unknown as WebSocket, { userId: 3 });
  tagAuthenticatedWebSocket(fromId as unknown as WebSocket, { id: 'local-user' });

  assert.equal(fromUserId.authenticatedUserId, 3);
  assert.equal(fromId.authenticatedUserId, 'local-user');
});

test('revocation closes every matching socket and leaves other users connected', () => {
  const first = { ...createSocket(), authenticatedUserId: 3 };
  const second = { ...createSocket(), authenticatedUserId: 3 };
  const otherUser = { ...createSocket(), authenticatedUserId: 4 };
  const server = {
    clients: new Set([first, second, otherUser]),
  } as unknown as Pick<WebSocketServer, 'clients'>;

  assert.deepEqual(closeWebSocketsForUser(server, 3), {
    closed: 2,
    forceTerminated: 0,
    failed: 0,
  });
  assert.deepEqual(first.closeCalls, [[4001, 'Session revoked']]);
  assert.deepEqual(second.closeCalls, [[4001, 'Session revoked']]);
  assert.deepEqual(otherUser.closeCalls, []);
});

test('a failed graceful close is force-terminated and reported in aggregate', (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  const socket = {
    ...createSocket(),
    authenticatedUserId: 3,
    close: () => { throw new Error('close failed'); },
  };
  const server = { clients: new Set([socket]) } as unknown as Pick<WebSocketServer, 'clients'>;

  assert.deepEqual(closeWebSocketsForUser(server, 3), {
    closed: 0,
    forceTerminated: 1,
    failed: 0,
  });
  assert.equal(socket.terminateCalls, 1);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0]?.[1], { count: 1 });
});

test('a socket that cannot close or terminate produces one bounded failure diagnostic', (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const socket = {
    ...createSocket(),
    authenticatedUserId: 3,
    close: () => { throw new Error('close failed'); },
    terminate: () => { throw new Error('terminate failed'); },
  };
  const server = { clients: new Set([socket]) } as unknown as Pick<WebSocketServer, 'clients'>;

  assert.deepEqual(closeWebSocketsForUser(server, 3), {
    closed: 0,
    forceTerminated: 0,
    failed: 1,
  });
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0]?.[1], { count: 1 });
});
