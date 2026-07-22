import assert from 'node:assert/strict';
import test from 'node:test';

import { withGlobals, createLocalStorage } from '../../../test/nodeStubs';

import { parseShellMessage, getShellWebSocketUrl, sendSocketMessage } from './socket';

// socket.ts holds the pure/near-pure WebSocket plumbing for the terminal panel.
// These cover message parsing, the auth-token-gated URL builder (OSS/non-
// platform path — `IS_PLATFORM` is false under the unit runner), and the
// open-state send guard. window/localStorage/WebSocket are stubbed per test.

// ── parseShellMessage ────────────────────────────────────────────────────────

test('parseShellMessage returns the parsed object for valid JSON', () => {
  assert.deepEqual(parseShellMessage('{"type":"output","data":"hi"}'), {
    type: 'output',
    data: 'hi',
  } as never);
});

test('parseShellMessage returns null for malformed or empty payloads', () => {
  assert.equal(parseShellMessage('{not json'), null);
  assert.equal(parseShellMessage(''), null);
});

// ── getShellWebSocketUrl (non-platform / token path) ─────────────────────────

const withWindow = <T>(
  location: { protocol: string; host: string },
  storage: Record<string, string>,
  fn: (errors: unknown[][]) => T,
): T => {
  const errors: unknown[][] = [];
  return withGlobals(
    {
      window: { location },
      localStorage: createLocalStorage(storage),
      console: { ...console, error: (...args: unknown[]) => errors.push(args) },
    },
    () => fn(errors),
  );
};

test('getShellWebSocketUrl builds a ws:// URL with the URL-encoded auth token', () => {
  const url = withWindow(
    { protocol: 'http:', host: 'localhost:3000' },
    { 'auth-token': 'a b/c' },
    () => getShellWebSocketUrl(),
  );
  assert.equal(url, 'ws://localhost:3000/shell?token=a%20b%2Fc');
});

test('getShellWebSocketUrl upgrades to wss:// under https', () => {
  const url = withWindow(
    { protocol: 'https:', host: 'example.com' },
    { 'auth-token': 'tok' },
    () => getShellWebSocketUrl(),
  );
  assert.equal(url, 'wss://example.com/shell?token=tok');
});

test('getShellWebSocketUrl returns null and logs when no auth token is stored', () => {
  const errors: unknown[][] = [];
  const url = withWindow({ protocol: 'http:', host: 'localhost' }, {}, (errs) => {
    const result = getShellWebSocketUrl();
    errors.push(...errs);
    return result;
  });
  assert.equal(url, null);
  assert.equal(errors.length, 1);
});

// ── sendSocketMessage ────────────────────────────────────────────────────────

const message = { type: 'input', data: 'ls\n' } as never;

test('sendSocketMessage sends (serialized) only when the socket is OPEN', () => {
  withGlobals({ WebSocket: { OPEN: 1 } }, () => {
    const sent: string[] = [];
    const open = { readyState: 1, send: (m: string) => sent.push(m) } as unknown as WebSocket;
    sendSocketMessage(open, message);
    assert.deepEqual(sent, [JSON.stringify(message)]);
  });
});

test('sendSocketMessage is a no-op for a non-open or null socket', () => {
  withGlobals({ WebSocket: { OPEN: 1 } }, () => {
    const sent: string[] = [];
    const closed = { readyState: 3, send: (m: string) => sent.push(m) } as unknown as WebSocket;
    sendSocketMessage(closed, message);
    sendSocketMessage(null, message);
    assert.deepEqual(sent, []);
  });
});
