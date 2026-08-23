import assert from 'node:assert/strict';
import test from 'node:test';

import { ServerSentEventDecoder, streamAuthenticatedSse } from './sse';

test('SSE decoder preserves named events across arbitrary chunks', () => {
  const decoder = new ServerSentEventDecoder();
  const events = [
    ...decoder.push('event: res'),
    ...decoder.push('ult\r\ndata: {"ok"'),
    ...decoder.push(':true}\r\n\r\nevent: done\ndata: {}\n\n'),
    ...decoder.finish(),
  ];

  assert.deepEqual(events, [
    { event: 'result', data: '{"ok":true}' },
    { event: 'done', data: '{}' },
  ]);
});

test('SSE decoder joins repeated data fields and dispatches the final event at EOF', () => {
  const decoder = new ServerSentEventDecoder();
  assert.deepEqual(decoder.push('data: first\ndata: second'), []);
  assert.deepEqual(decoder.finish(), [{ event: 'message', data: 'first\nsecond' }]);
});

test('authenticated SSE sends the bearer token in a header', async (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => key === 'auth-token' ? 'header-secret' : null,
      setItem: () => {},
    },
  });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  let requestInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requestInit = init;
    return new Response('event: done\ndata: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  const events: string[] = [];
  await streamAuthenticatedSse('/api/stream', (event) => events.push(event.event));

  assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bearer header-secret');
  assert.deepEqual(events, ['done']);
});
