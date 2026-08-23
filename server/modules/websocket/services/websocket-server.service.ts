import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
};

/**
 * Keep WebSocket alive across reverse-proxy idle timeouts (Cloudflare ~100s,
 * AWS ALB 60s, nginx 60s, etc.). Without app-level pings these connections are
 * silently torn down even when the UI is active, causing repeated reconnect
 * cycles. ws library heartbeat is opt-in.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** The subset of a `ws` socket the heartbeat drives. */
type HeartbeatSocket = {
  readyState: number;
  OPEN: number;
  on: (event: string, listener: () => void) => unknown;
  ping: () => void;
  terminate: () => void;
};

/**
 * Pings a socket on an interval and terminates it when a ping goes unanswered.
 *
 * The pong half is what makes this a heartbeat rather than a keepalive (#389).
 * Pinging alone proves nothing: a client whose connection has black-holed — a
 * laptop that slept, a network handover — never sends a FIN, so without a reply
 * deadline the server pings into the void forever and keeps a dead socket in
 * `connectedClients`, still holding the writer for any run fanning out to it.
 * Browsers answer protocol pings automatically, so this direction needs no
 * client cooperation.
 *
 * Exported (and parameterised on the timer) so the terminate-on-silence rule is
 * unit-testable without standing up a real server and a real socket.
 */
export function attachHeartbeat(
  ws: HeartbeatSocket,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  scheduler: {
    setInterval: (handler: () => void, ms: number) => unknown;
    clearInterval: (handle: never) => void;
  } = globalThis as never,
  /** Names the socket in the termination log. Chat, shell, and plugin sockets
   *  all pass through here, and only chat logs its own disconnects. */
  label = 'websocket',
): () => void {
  let awaitingPong = false;
  ws.on('pong', () => {
    awaitingPong = false;
  });

  const heartbeat = scheduler.setInterval(() => {
    if (awaitingPong) {
      // A full interval elapsed with no pong: the peer is gone. `terminate()`
      // rather than `close()` because a closing handshake needs a live
      // connection — `close()` on a black-holed socket waits for a reply that
      // cannot come, which is the very stall this exists to end. Terminating
      // fires the 'close' handlers that stop this timer and unsubscribe the
      // socket from every run.
      //
      // Logged because a silent terminate would recreate #389's real problem —
      // a connection dying with no observable signal. Shell and plugin sockets
      // log nothing on close at all, so without this line a heartbeat kill on
      // those paths is completely invisible to an operator.
      console.warn(`[Heartbeat] Terminating unresponsive ${label}: no pong within ${intervalMs}ms`);
      ws.terminate();
      return;
    }
    if (ws.readyState === ws.OPEN) {
      try {
        awaitingPong = true;
        ws.ping();
      } catch {
        // Socket closed concurrently — the stop below clears the timer.
        awaitingPong = false;
      }
    }
  }, intervalMs);

  const stopHeartbeat = () => scheduler.clearInterval(heartbeat as never);
  ws.on('close', stopHeartbeat);
  ws.on('error', stopHeartbeat);
  return stopHeartbeat;
}

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    verifyClient: ((
      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]
    ) => verifyWebSocketClient(info, dependencies.verifyClient)),
  });

  wss.on('connection', (ws, request) => {
    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    // Path only — never the raw URL, which carries `?token=...`.
    attachHeartbeat(ws as unknown as HeartbeatSocket, HEARTBEAT_INTERVAL_MS, globalThis as never, pathname);

    if (pathname === '/shell') {
      handleShellConnection(ws, dependencies.shell);
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort);
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
