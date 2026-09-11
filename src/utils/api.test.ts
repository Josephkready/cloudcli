import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalStorage, withGlobals } from '../test/nodeStubs';

import { api } from './api';

test('conversation search URLs contain search inputs but no bearer token', () => {
  const url = api.searchConversationsUrl('fix login', 25);
  const parsed = new URL(url, 'https://cloudcli.example');

  assert.equal(parsed.searchParams.get('q'), 'fix login');
  assert.equal(parsed.searchParams.get('limit'), '25');
  assert.equal(parsed.searchParams.has('token'), false);
});

test('logout explicitly sends the token being revoked without reading storage', async (t) => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Refreshed-Token': 'ignored' },
    });
  });

  await api.auth.logout('token-being-revoked');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, '/api/auth/logout');
  assert.equal(requests[0].init?.method, 'POST');
  assert.deepEqual(requests[0].init?.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer token-being-revoked',
  });
});

// --- createBugReport screenshots (dante-config skills/bug-report-button/SKILL.md §9) --------

test('createBugReport posts plain JSON for an image-free report, unchanged', async (t) => {
  const store = createLocalStorage();
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ success: true, data: { status: 'queued', id: 'job-1' } }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  await withGlobals({ localStorage: store }, () =>
    api.createBugReport({ description: 'it broke', metadata: { sessionId: 's1' } }),
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, '/api/bug-report');
  assert.equal(requests[0].init?.method, 'POST');
  assert.equal(
    (requests[0].init?.headers as Record<string, string> | undefined)?.['Content-Type'],
    'application/json',
  );
  assert.equal(
    requests[0].init?.body,
    JSON.stringify({ description: 'it broke', metadata: { sessionId: 's1' } }),
  );
});

test('createBugReport switches to multipart FormData only once an attachment is staged', async (t) => {
  const store = createLocalStorage();
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ success: true, data: { status: 'queued', id: 'job-1' } }), {
      status: 202,
    });
  });

  const blob = new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });
  await withGlobals({ localStorage: store }, () =>
    api.createBugReport({
      description: 'see attached',
      metadata: { sessionId: 's1' },
      attachments: [{ name: 'shot.jpg', blob }],
    }),
  );

  assert.equal(requests.length, 1);
  const body = requests[0].init?.body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get('description'), 'see attached');
  assert.equal(body.get('metadata'), JSON.stringify({ sessionId: 's1' }));
  const uploaded = body.get('attachments');
  assert.ok(uploaded instanceof Blob);
  assert.equal((uploaded as File).name, 'shot.jpg');
  // FormData must be left for the browser/runtime to set its own multipart
  // boundary — an explicit Content-Type here would drop it and break parsing.
  assert.equal((requests[0].init?.headers as Record<string, string> | undefined)?.['Content-Type'], undefined);
});

test('createBugReport carries every staged attachment as its own multipart part', async (t) => {
  const store = createLocalStorage();
  const requests: Array<{ init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ init });
    return new Response(JSON.stringify({ success: true, data: { status: 'queued', id: 'job-1' } }), {
      status: 202,
    });
  });

  await withGlobals({ localStorage: store }, () =>
    api.createBugReport({
      description: 'three screenshots',
      metadata: {},
      attachments: [
        { name: 'a.jpg', blob: new Blob(['a'], { type: 'image/jpeg' }) },
        { name: 'b.jpg', blob: new Blob(['b'], { type: 'image/jpeg' }) },
        { name: 'c.jpg', blob: new Blob(['c'], { type: 'image/jpeg' }) },
      ],
    }),
  );

  const body = requests[0].init?.body as FormData;
  assert.deepEqual(body.getAll('attachments').map((entry) => (entry as File).name), ['a.jpg', 'b.jpg', 'c.jpg']);
});
