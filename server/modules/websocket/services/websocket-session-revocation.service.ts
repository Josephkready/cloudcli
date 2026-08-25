import type { WebSocketServer, WebSocket } from 'ws';

import type { AuthenticatedWebSocketUser } from '@/shared/types.js';

const SESSION_REVOKED_CLOSE_CODE = 4001;
const SESSION_REVOKED_CLOSE_REASON = 'Session revoked';

type RevocableWebSocket = WebSocket & {
  authenticatedUserId?: string | number;
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
): number {
  let closed = 0;
  for (const socket of server.clients) {
    const revocableSocket = socket as RevocableWebSocket;
    if (revocableSocket.authenticatedUserId !== userId) {
      continue;
    }
    try {
      revocableSocket.close(SESSION_REVOKED_CLOSE_CODE, SESSION_REVOKED_CLOSE_REASON);
      closed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Auth] Failed to close a revoked WebSocket', { error: message });
    }
  }
  return closed;
}
