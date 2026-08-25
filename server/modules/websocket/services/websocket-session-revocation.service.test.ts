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
  close(code: number, reason: string): void;
};

function createSocket(): FakeSocket {
  return {
    closeCalls: [],
    close(code, reason) {
      this.closeCalls.push([code, reason]);
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

  assert.equal(closeWebSocketsForUser(server, 3), 2);
  assert.deepEqual(first.closeCalls, [[4001, 'Session revoked']]);
  assert.deepEqual(second.closeCalls, [[4001, 'Session revoked']]);
  assert.deepEqual(otherUser.closeCalls, []);
});
