import type { WebSocketServer, WebSocket } from 'ws';

import type { AuthenticatedWebSocketUser } from '@/shared/types.js';

const SESSION_REVOKED_CLOSE_CODE = 4001;
const SESSION_REVOKED_CLOSE_REASON = 'Session revoked';

type RevocableWebSocket = WebSocket & {
  authenticatedUserId?: string | number;
};

export type WebSocketRevocationResult = {
  closed: number;
  forceTerminated: number;
  failed: number;
};

export function tagAuthenticatedWebSocket(
  socket: WebSocket,
  user: AuthenticatedWebSocketUser | undefined,
): void {
  const userId = user?.userId ?? user?.id;
  if (typeof userId === 'string' || typeof userId === 'number') {
    (socket as RevocableWebSocket).authenticatedUserId = userId;
  }
}

/** Closes every live websocket authenticated as the revoked user. */
export function closeWebSocketsForUser(
  server: Pick<WebSocketServer, 'clients'>,
  userId: string | number,
): WebSocketRevocationResult {
  let closed = 0;
  let forceTerminated = 0;
  let failed = 0;
  for (const socket of server.clients) {
    const revocableSocket = socket as RevocableWebSocket;
    if (revocableSocket.authenticatedUserId !== userId) {
      continue;
    }
    try {
      revocableSocket.close(SESSION_REVOKED_CLOSE_CODE, SESSION_REVOKED_CLOSE_REASON);
      closed += 1;
    } catch {
      try {
        revocableSocket.terminate();
        forceTerminated += 1;
      } catch {
        failed += 1;
      }
    }
  }
  if (forceTerminated > 0) {
    console.warn('[Auth] Force-terminated WebSockets after graceful revocation failed', {
      count: forceTerminated,
    });
  }
  if (failed > 0) {
    console.error('[Auth] Failed to disconnect revoked WebSockets', { count: failed });
  }
  return { closed, forceTerminated, failed };
}
