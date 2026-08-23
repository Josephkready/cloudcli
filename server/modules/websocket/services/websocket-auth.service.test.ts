import assert from 'node:assert/strict';
import test from 'node:test';

import type { VerifyClientCallbackSync } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

import { isAllowedWebSocketOrigin, verifyWebSocketClient } from './websocket-auth.service.js';

test('WebSocket origins must match the upgrade request host', () => {
  assert.equal(isAllowedWebSocketOrigin('https://cloudcli.example', 'cloudcli.example'), true);
  assert.equal(isAllowedWebSocketOrigin('http://localhost:3001', 'localhost:3001'), true);
  assert.equal(isAllowedWebSocketOrigin('https://attacker.example', 'cloudcli.example'), false);
  assert.equal(isAllowedWebSocketOrigin('null', 'cloudcli.example'), false);
  assert.equal(isAllowedWebSocketOrigin(undefined, 'cloudcli.example'), true);
});

test('origin validation runs before platform-mode authentication bypass', () => {
  let authenticationCalls = 0;
  const request = {
    url: '/shell',
    headers: {
      host: 'cloudcli.example',
      origin: 'https://attacker.example',
    },
  } as AuthenticatedWebSocketRequest;
  const info = { req: request } as Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0];

  const accepted = verifyWebSocketClient(info, {
    isPlatform: true,
    authenticateWebSocket: () => {
      authenticationCalls += 1;
      return { userId: 1, username: 'test' };
    },
  });

  assert.equal(accepted, false);
  assert.equal(authenticationCalls, 0);
  assert.equal(request.user, undefined);
});
