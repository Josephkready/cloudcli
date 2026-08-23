import { WebSocket } from 'ws';

/**
 * Proxies an authenticated client websocket to a plugin websocket endpoint.
 */
export function handlePluginWsProxy(
  clientWs: WebSocket,
  pathname: string,
  getPluginPort: (pluginName: string) => number | null,
  createUpstream: (url: string) => WebSocket = (url) => new WebSocket(url),
): void {
  const pluginName = pathname.replace('/plugin-ws/', '');
  if (!pluginName || /[^a-zA-Z0-9_-]/.test(pluginName)) {
    clientWs.close(4400, 'Invalid plugin name');
    return;
  }

  const port = getPluginPort(pluginName);
  if (!port) {
    clientWs.close(4404, 'Plugin not running');
    return;
  }

  const upstream = createUpstream(`ws://127.0.0.1:${port}/ws`);

  const closeUpstream = (): void => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate();
    } else if (upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  };

  upstream.on('open', () => {
    // The client can disappear while the upstream HTTP upgrade is in flight.
    // Recheck at open as a second line of defense against an orphaned proxy.
    if (clientWs.readyState !== WebSocket.OPEN) {
      upstream.close();
      return;
    }
    console.log(`[Plugins] WS proxy connected to "${pluginName}" on port ${port}`);
  });

  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  upstream.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  clientWs.on('close', () => {
    closeUpstream();
  });

  upstream.on('error', (error) => {
    console.error(`[Plugins] WS proxy error for "${pluginName}":`, error.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(4502, 'Upstream error');
    }
  });

  clientWs.on('error', () => {
    closeUpstream();
  });
}
