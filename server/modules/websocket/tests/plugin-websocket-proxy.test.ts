import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  closes = 0;
  terminations = 0;

  send(): void {}

  close(): void {
    this.closes += 1;
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
    this.terminations += 1;
    this.readyState = WebSocket.CLOSED;
  }
}

test('closing a client during the upstream handshake terminates that handshake', () => {
  const client = new FakeSocket();
  const upstream = new FakeSocket();
  upstream.readyState = WebSocket.CONNECTING;

  handlePluginWsProxy(
    client as unknown as WebSocket,
    '/plugin-ws/example',
    () => 4321,
    () => upstream as unknown as WebSocket,
  );
  client.readyState = WebSocket.CLOSED;
  client.emit('close');

  assert.equal(upstream.terminations, 1);
});

test('an upstream that opens after its client vanished is closed immediately', () => {
  const client = new FakeSocket();
  const upstream = new FakeSocket();
  upstream.readyState = WebSocket.CONNECTING;

  handlePluginWsProxy(
    client as unknown as WebSocket,
    '/plugin-ws/example',
    () => 4321,
    () => upstream as unknown as WebSocket,
  );
  client.readyState = WebSocket.CLOSED;
  upstream.readyState = WebSocket.OPEN;
  upstream.emit('open');

  assert.equal(upstream.closes, 1);
});
