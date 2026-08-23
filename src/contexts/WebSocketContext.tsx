import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `chat_send_accepted`, `pong`, `session_upserted`,
 * `loading_progress`, `protocol_error`). The synthetic `websocket_reconnected`
 * kind is injected client-side when the socket re-opens after a drop.
 *
 * `pong` and the `UNKNOWN_MESSAGE_TYPE` flavour of `protocol_error` answering a
 * `chat.ping` are consumed here and never dispatched — they are liveness
 * plumbing, not application events (#389).
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  /**
   * Hands a frame to the socket. Returns whether it was actually written.
   *
   * `false` means the frame went nowhere and the caller still owns it. Note the
   * converse is weaker than it looks: `true` only means the socket accepted the
   * bytes, NOT that the server received them — a half-open connection (common
   * on iOS) reports OPEN and swallows the frame silently. Callers that must not
   * lose data need server confirmation as well; see `pendingSends.ts` (#325).
   */
  sendMessage: (message: unknown) => boolean;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames can never be coalesced or
   * dropped the way a single "latest message" state slot could.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

/**
 * Liveness timings (#389).
 *
 * The problem being solved: a socket whose connection has black-holed — the
 * machine slept, the network changed — stays `readyState === OPEN` forever. No
 * `close` event, no `error` event, so a reconnect keyed solely on `onclose`
 * never happens and the app is wedged until the page is reloaded. The only way
 * to find out is to ask and time out.
 */
/** How often liveness is evaluated. Cheap: usually just a clock comparison. */
const LIVENESS_CHECK_INTERVAL_MS = 5_000;
/**
 * Silence that must elapse before we probe. Any inbound frame is proof of life,
 * so a busy socket (a streaming run) is never probed at all.
 */
const IDLE_BEFORE_PROBE_MS = 20_000;
/**
 * How long a probe may go unanswered before the socket is declared dead. Sized
 * well above any plausible round trip on a LAN/tailnet deployment so a slow
 * response is never mistaken for a dead peer.
 */
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;
/**
 * How long a handshake may hang before it is abandoned.
 *
 * The liveness timer only starts at `onopen`, so a socket stuck in CONNECTING —
 * no open, no close, no error — would otherwise be the one state with no
 * coverage at all, waiting on whatever connect timeout the browser happens to
 * apply. Same failure to the user as #389: wedged with no reconnect.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Whether a frame is a server rejecting our liveness probe, rather than a real
 * failure the chat should see (#389).
 *
 * A `protocol_error` reaching the chat is not cosmetic: `useChatRealtimeHandlers`
 * renders it as an error message in the conversation AND marks the session idle,
 * so a probe rejected every 20s would spray fake errors into whatever session is
 * open and stop the spinner on a live run.
 *
 * Two shapes have to be recognised, which is why this is not a single equality
 * check:
 *  - A CURRENT server names the type it rejected, so `type === 'chat.ping'` is
 *    conclusive on its own.
 *  - An OLDER server predates that field entirely and sends no `type` — the
 *    very case this exists for. All that identifies it is that we had a probe
 *    outstanding and the server said it did not recognise the message. Matching
 *    on `type` alone silently failed to cover the only server that needs it.
 */
const isProbeRejection = (data: ServerEvent | null, answersProbe: boolean): boolean => {
  if (data?.kind !== 'protocol_error' || data?.code !== 'UNKNOWN_MESSAGE_TYPE') {
    return false;
  }
  // Conclusive on its own: this server names types, and it named ours.
  if (data?.type === 'chat.ping') return true;
  // No `type` at all means the server predates that field — the only server
  // that needs this branch. A current server always sends the key (even when
  // empty), so an absent one is unambiguous.
  return data?.type === undefined && answersProbe;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  /**
   * The socket this provider currently owns, in ANY readyState.
   *
   * Distinct from `wsRef`, which only ever holds an OPEN socket. Two things
   * need this (#389): a socket still CONNECTING is invisible to `wsRef` and so
   * used to survive cleanup as an orphan that later hijacked `wsRef`, and a
   * *stale* socket's late `close` event used to null out `wsRef` for the live
   * socket that had already replaced it.
   */
  const activeSocketRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /** Timestamp of the last inbound frame — any frame is proof the socket lives. */
  const lastFrameAtRef = useRef(0);
  /** When the outstanding liveness probe was sent, or 0 when none is in flight. */
  const probeSentAtRef = useRef(0);
  /**
   * When a probe was last written, regardless of what has arrived since.
   *
   * Deliberately separate from `probeSentAtRef`, which any inbound frame clears
   * because any frame proves the socket is alive. That is right for liveness and
   * wrong for attribution: an unrelated push (a sidebar delta, a stream event on
   * another subscribed run) landing between the probe and an OLD server's
   * untyped rejection would clear the flag, and the rejection would then be
   * dispatched into the chat as a fake error. This one answers a different
   * question — "did we recently ask?" — so it survives that.
   */
  const lastProbeAtRef = useRef(0);
  const livenessTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Abandons a handshake that never completes. Cleared the moment one does. */
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  const stopLivenessTimer = useCallback(() => {
    if (livenessTimerRef.current) {
      clearInterval(livenessTimerRef.current);
      livenessTimerRef.current = null;
    }
    probeSentAtRef.current = 0;
  }, []);

  const stopConnectTimeout = useCallback(() => {
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  /**
   * Gives up on a socket and schedules a fresh one.
   *
   * Deliberately does NOT wait for the browser to fire `close`. On a black-holed
   * connection `close()` starts a handshake whose reply can never arrive, so the
   * event can be many seconds away or never come at all — waiting for it is the
   * very failure this is here to end. The socket's handlers are detached first
   * so its eventual (or never) `close` cannot double-schedule a reconnect.
   */
  const teardown = useCallback((socket: WebSocket | null, reason: string) => {
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // Already closing/closed — nothing to do, the reconnect below still runs.
      }
    }
    if (activeSocketRef.current === socket) {
      activeSocketRef.current = null;
    }
    if (wsRef.current === socket) {
      wsRef.current = null;
    }
    stopLivenessTimer();
    stopConnectTimeout();
    setIsConnected(false);

    if (unmountedRef.current) return;
    console.warn(`WebSocket reconnecting: ${reason}`);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    reconnectTimeoutRef.current = setTimeout(() => {
      if (unmountedRef.current) return; // Prevent reconnection if unmounted
      connectRef.current();
    }, RECONNECT_DELAY_MS);
  }, [stopLivenessTimer, stopConnectTimeout]);

  /**
   * Sends a liveness probe if one is not already outstanding.
   *
   * Writing the probe cannot itself detect a dead socket — that is the whole
   * point of #389, a half-open socket accepts the bytes and reports success — so
   * the answer comes from the deadline in `checkLiveness`, not from here.
   */
  const probe = useCallback((socket: WebSocket) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (probeSentAtRef.current !== 0) return; // already waiting on one
    try {
      socket.send(JSON.stringify({ type: 'chat.ping' }));
      probeSentAtRef.current = Date.now();
      lastProbeAtRef.current = probeSentAtRef.current;
    } catch {
      // A throwing send is unambiguous: the socket is gone.
      teardown(socket, 'probe could not be written');
    }
  }, [teardown]);

  const checkLiveness = useCallback((socket: WebSocket) => {
    if (activeSocketRef.current !== socket) return;
    const now = Date.now();

    if (probeSentAtRef.current !== 0) {
      if (now - probeSentAtRef.current > PONG_TIMEOUT_MS) {
        // Asked, and heard nothing back within the deadline. This is the only
        // signal that distinguishes a half-open socket from an idle one.
        teardown(socket, 'liveness probe timed out');
      }
      return;
    }

    if (now - lastFrameAtRef.current >= IDLE_BEFORE_PROBE_MS) {
      probe(socket);
    }
  }, [probe, teardown]);

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Claimed before it opens, so cleanup can close a socket that is still
      // CONNECTING and a superseded socket can be recognised as stale (#389).
      activeSocketRef.current = websocket;

      stopConnectTimeout();
      connectTimeoutRef.current = setTimeout(() => {
        if (activeSocketRef.current !== websocket) return;
        if (websocket.readyState === WebSocket.CONNECTING) {
          teardown(websocket, 'handshake timed out');
        }
      }, CONNECT_TIMEOUT_MS);

      websocket.onopen = () => {
        if (activeSocketRef.current !== websocket) {
          // Superseded while connecting — a newer socket owns the provider now.
          websocket.close();
          return;
        }
        stopConnectTimeout();
        setIsConnected(true);
        wsRef.current = websocket;
        lastFrameAtRef.current = Date.now();
        probeSentAtRef.current = 0;

        stopLivenessTimer();
        livenessTimerRef.current = setInterval(
          () => checkLiveness(websocket),
          LIVENESS_CHECK_INTERVAL_MS,
        );

        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        const now = Date.now();
        // Whether a probe went out recently enough that this frame could be its
        // rejection. Based on when we last ASKED, not on whether a reply is
        // still outstanding, so an unrelated frame arriving first cannot make an
        // old server's rejection look unsolicited.
        const answersProbe = lastProbeAtRef.current !== 0
          && now - lastProbeAtRef.current <= PONG_TIMEOUT_MS;
        // Proof of life regardless of what the frame turns out to be — recorded
        // before parsing so even a malformed frame counts.
        lastFrameAtRef.current = now;
        probeSentAtRef.current = 0;
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          // The probe's own answer carries no application meaning; everything
          // needed from it (the timestamps above) is already recorded.
          if (data?.kind === 'pong') {
            lastProbeAtRef.current = 0; // answered; nothing left to attribute
            return;
          }
          if (isProbeRejection(data, answersProbe)) {
            lastProbeAtRef.current = 0;
            return;
          }
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        // A stale socket's late close must not tear down the live one that has
        // already replaced it (#389).
        if (activeSocketRef.current !== websocket) return;
        teardown(websocket, 'socket closed');
      };

      websocket.onerror = (error) => {
        // Only the event TYPE. The raw Event's `target` is the socket, whose
        // `url` carries `?token=...` — logging the object puts the auth token in
        // the console and in anything that ships console output.
        console.error('WebSocket error:', error instanceof Event ? error.type : error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [token, dispatch, checkLiveness, stopLivenessTimer, stopConnectTimeout, teardown]); // everytime token changes, we reconnect

  // `teardown` and the reconnect timer reach the CURRENT connect through this,
  // rather than capturing whichever one existed when the socket was created.
  const connectRef = useRef(connect);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      stopLivenessTimer();
      stopConnectTimeout();
      // `activeSocketRef`, not `wsRef`: a socket still CONNECTING is absent from
      // `wsRef` and used to survive this cleanup, open later, and hijack the
      // provider's socket slot behind the replacement's back (#389).
      if (activeSocketRef.current) {
        const socket = activeSocketRef.current;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        activeSocketRef.current = null;
      }
      wsRef.current = null;
    };
  }, [token]); // everytime token changes, we reconnect

  /**
   * Resuming is the single most likely moment to be holding a dead socket: the
   * machine slept, the network changed, or the tab was backgrounded long enough
   * for the connection to be reclaimed — which is exactly the shape reported in
   * #389 ("stuck until you close and reopen the app"). Probing on resume turns a
   * wedge that lasted until the user reloaded into one that clears in seconds.
   */
  useEffect(() => {
    const probeNow = () => {
      const socket = activeSocketRef.current;
      if (!socket || unmountedRef.current) return;
      if (socket.readyState === WebSocket.OPEN) {
        probe(socket);
        return;
      }
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        // The browser noticed while we were away but the reconnect timer may be
        // a while out; go now rather than sit disconnected.
        teardown(socket, 'socket found closed on resume');
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') probeNow();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', probeNow);
    window.addEventListener('focus', probeNow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', probeNow);
      window.removeEventListener('focus', probeNow);
    };
  }, [probe, teardown]);

  const sendMessage = useCallback((message: unknown): boolean => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // Returning false rather than only warning: this used to be a silent
      // drop, which is how a sent chat message could vanish with the UI still
      // showing it as delivered (#325).
      console.warn('WebSocket not connected');
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      // `send()` still throws if the socket closed between the readyState check
      // and the write, and a serialization failure would otherwise surface as an
      // unhandled error mid-submit.
      console.error('WebSocket send failed:', error);
      return false;
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected
  }), [sendMessage, subscribe, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
