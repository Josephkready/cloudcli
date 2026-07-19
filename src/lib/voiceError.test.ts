import assert from 'node:assert/strict';
import test from 'node:test';

import { readVoiceError } from './voiceError';

test('surfaces the voice-proxy JSON error message', async () => {
  const res = new Response(JSON.stringify({ error: 'Voice backend unreachable: ECONNREFUSED' }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(await readVoiceError(res), 'Voice backend unreachable: ECONNREFUSED');
});

test('trims surrounding whitespace on the error message', async () => {
  const res = new Response(JSON.stringify({ error: '  No voice backend configured  ' }), {
    status: 503,
  });
  assert.equal(await readVoiceError(res), 'No voice backend configured');
});

test('falls back to HTTP <status> for a non-JSON body', async () => {
  const res = new Response('<html>502 Bad Gateway</html>', { status: 502 });
  assert.equal(await readVoiceError(res), 'HTTP 502');
});

test('falls back to HTTP <status> for an empty body', async () => {
  const res = new Response(null, { status: 504 });
  assert.equal(await readVoiceError(res), 'HTTP 504');
});

test('falls back to HTTP <status> when JSON has no error string', async () => {
  const res = new Response(JSON.stringify({ text: 'not an error' }), { status: 500 });
  assert.equal(await readVoiceError(res), 'HTTP 500');
});

test('does not consume the body (clone leaves it readable)', async () => {
  const res = new Response(JSON.stringify({ error: 'boom' }), { status: 502 });
  await readVoiceError(res);
  // The original body is still intact because readVoiceError reads a clone.
  assert.deepEqual(await res.json(), { error: 'boom' });
});
