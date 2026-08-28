import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

// voice-proxy freezes its ENV at import time, so each case needs a fresh module
// instance with the env already in place. A unique query string defeats the ESM
// module cache the same way the AUTH_DISABLED tests do it.
let moduleSeq = 0;
async function loadRouter(env) {
  const saved = {};
  const keys = [
    'VOICE_API_BASE_URL', 'VOICE_API_KEY', 'VOICE_STT_BASE_URL',
    'VOICE_STT_API_KEY', 'VOICE_STT_API_KEY_FILE', 'VOICE_STT_MODEL',
    'VOICE_TTS_MODEL', 'VOICE_TTS_VOICE',
  ];
  for (const k of keys) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const mod = await import(`./voice-proxy.js?case=${++moduleSeq}`);
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return mod.default;
}

/** Mount the router on a throwaway server and return its base URL + closer. */
async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/voice', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/api/voice`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Record every call the proxy makes to a BACKEND instead of really making it.
 * The test drives the proxy over HTTP too, so requests aimed at the test server
 * itself have to fall through to the real fetch — otherwise the first thing
 * recorded is the test's own request and every assertion reads the wrong call.
 */
function stubFetch(calls, selfOrigin) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(selfOrigin)) return original(url, options);
    calls.push({ url: String(url), auth: options?.headers?.Authorization ?? null });
    return new Response(JSON.stringify({ text: 'ok' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  return () => { globalThis.fetch = original; };
}

function audioForm() {
  const fd = new FormData();
  fd.append('audio', new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 'clip.webm');
  return fd;
}

test('STT falls back to VOICE_API_BASE_URL when no STT override is set', async () => {
  const router = await loadRouter({
    VOICE_API_BASE_URL: 'https://shared.example/v1', VOICE_API_KEY: 'shared-key',
  });
  const { url, close } = await serve(router);
  const calls = [];
  const restore = stubFetch(calls, url);
  try {
    const res = await fetch(`${url}/transcribe`, { method: 'POST', body: audioForm() });
    assert.equal(res.status, 200);
    assert.equal(calls[0].url, 'https://shared.example/v1/audio/transcriptions');
    assert.equal(calls[0].auth, 'Bearer shared-key');
  } finally {
    restore(); await close();
  }
});

test('STT and TTS resolve to different backends when the override is set', async () => {
  const router = await loadRouter({
    VOICE_API_BASE_URL: 'http://127.0.0.1:8853/v1',
    VOICE_STT_BASE_URL: 'https://hosted.example/v1',
    VOICE_STT_API_KEY: 'stt-key',
  });
  const { url, close } = await serve(router);
  const calls = [];
  const restore = stubFetch(calls, url);
  try {
    await fetch(`${url}/transcribe`, { method: 'POST', body: audioForm() });
    await fetch(`${url}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    // The mic goes to the hosted transcriber...
    assert.equal(calls[0].url, 'https://hosted.example/v1/audio/transcriptions');
    assert.equal(calls[0].auth, 'Bearer stt-key');
    // ...and the speaker still goes to the local, keyless TTS backend.
    assert.equal(calls[1].url, 'http://127.0.0.1:8853/v1/audio/speech');
    assert.equal(calls[1].auth, null);
  } finally {
    restore(); await close();
  }
});

test('a client-supplied key is not forwarded to a separately configured STT host', async () => {
  const router = await loadRouter({
    VOICE_API_BASE_URL: 'http://127.0.0.1:8853/v1',
    VOICE_STT_BASE_URL: 'https://hosted.example/v1',
    VOICE_STT_API_KEY: 'stt-key',
  });
  const { url, close } = await serve(router);
  const calls = [];
  const restore = stubFetch(calls, url);
  try {
    await fetch(`${url}/transcribe`, {
      method: 'POST', headers: { 'x-voice-api-key': 'key-for-the-other-backend' },
      body: audioForm(),
    });
    assert.equal(calls[0].auth, 'Bearer stt-key');
  } finally {
    restore(); await close();
  }
});

test('a client-supplied key still applies when STT is not split out', async () => {
  const router = await loadRouter({ VOICE_API_BASE_URL: 'https://shared.example/v1' });
  const { url, close } = await serve(router);
  const calls = [];
  const restore = stubFetch(calls, url);
  try {
    await fetch(`${url}/transcribe`, {
      method: 'POST', headers: { 'x-voice-api-key': 'from-client' }, body: audioForm(),
    });
    assert.equal(calls[0].auth, 'Bearer from-client');
  } finally {
    restore(); await close();
  }
});

test('the STT key can come from a file, so it never enters the environment', async () => {
  // dante-config forbids EnvironmentFile= on cloudcli.service: cloudcli hands its
  // environment to every agent it spawns, so the secret must stay on disk and be
  // read by the app. This is the path that makes that possible.
  const dir = mkdtempSync(join(tmpdir(), 'voice-key-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'UNRELATED=leak-me-not\nVOICE_STT_API_KEY=gsk_from_file\n');

  const router = await loadRouter({
    VOICE_STT_BASE_URL: 'https://hosted.example/v1',
    VOICE_STT_API_KEY_FILE: file,
  });
  const { url, close } = await serve(router);
  const calls = [];
  const restore = stubFetch(calls, url);
  try {
    await fetch(`${url}/transcribe`, { method: 'POST', body: audioForm() });
    assert.equal(calls[0].auth, 'Bearer gsk_from_file');
  } finally {
    restore(); await close();
  }
});

test('an inline STT key still wins over the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-key-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'VOICE_STT_API_KEY=from-file\n');

  const router = await loadRouter({
    VOICE_STT_BASE_URL: 'https://hosted.example/v1',
    VOICE_STT_API_KEY: 'inline-wins',
    VOICE_STT_API_KEY_FILE: file,
  });
  const { url, close } = await serve(router);
  const calls = [];
  const restore = stubFetch(calls, url);
  try {
    await fetch(`${url}/transcribe`, { method: 'POST', body: audioForm() });
    assert.equal(calls[0].auth, 'Bearer inline-wins');
  } finally {
    restore(); await close();
  }
});

test('a missing key file leaves the request unauthenticated rather than failing', async () => {
  const router = await loadRouter({
    VOICE_STT_BASE_URL: 'https://hosted.example/v1',
    VOICE_STT_API_KEY_FILE: join(tmpdir(), 'no-such-dir-4a91', '.env'),
  });
  const { url, close } = await serve(router);
  const calls = [];
  const restore = stubFetch(calls, url);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const res = await fetch(`${url}/transcribe`, { method: 'POST', body: audioForm() });
    assert.equal(res.status, 200);
    assert.equal(calls[0].auth, null);
  } finally {
    console.warn = warn; restore(); await close();
  }
});

test('health reports each half, and configured is true for an STT-only deploy', async () => {
  const router = await loadRouter({ VOICE_STT_BASE_URL: 'https://hosted.example/v1' });
  const { url, close } = await serve(router);
  try {
    const body = await (await fetch(`${url}/health`)).json();
    assert.deepEqual(body, { configured: true, stt: true, tts: false });
  } finally {
    await close();
  }
});

test('health is unconfigured when neither half has a backend', async () => {
  const router = await loadRouter({});
  const { url, close } = await serve(router);
  try {
    const body = await (await fetch(`${url}/health`)).json();
    assert.deepEqual(body, { configured: false, stt: false, tts: false });
    const res = await fetch(`${url}/transcribe`, { method: 'POST', body: audioForm() });
    assert.equal(res.status, 503);
  } finally {
    await close();
  }
});
