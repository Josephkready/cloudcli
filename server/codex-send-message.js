/**
 * Forward a normalized frame from the Codex runtime to the run's writer.
 *
 * Every transport the Codex runtime is handed is one of the app's writer
 * abstractions — `SSEStreamWriter` and `ResponseCollector` (server/routes/agent.js
 * + response-collector.js) for the REST path, and the chat `WebSocketWriter`
 * (server/modules/websocket) for the live path. All of them accept a structured
 * object and own their own encoding, exactly like the writers the other provider
 * runtimes (e.g. claude-sdk.js) call `ws.send(...)` on
 * directly. A raw `ws` socket is never passed here — the chat layer wraps sockets
 * in a `WebSocketWriter` before dispatching.
 *
 * The previous implementation keyed off an allow-list (`isSSEStreamWriter ||
 * isWebSocketWriter`, else `JSON.stringify(data)`), which silently stringified
 * frames for any writer it didn't recognize. `ResponseCollector` sets neither
 * flag, so Codex frames reached it as JSON strings — a root cause of #96 — and the
 * next object-accepting writer added anywhere would hit the same trap. Hand the
 * object straight to `ws.send`; the try/catch keeps a transport error from
 * aborting the run. See #126.
 */
export function sendMessage(ws, data) {
  try {
    if (typeof ws?.send === 'function') {
      ws.send(data);
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}
