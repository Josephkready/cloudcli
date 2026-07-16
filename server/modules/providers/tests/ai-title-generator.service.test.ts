import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanTitle,
  generateShortTitle,
} from '@/modules/providers/services/ai-title-generator.service.js';

test('cleanTitle strips quotes, preambles, trailing punctuation, and collapses whitespace', () => {
  assert.equal(cleanTitle('"Fix Checkout Crash"'), 'Fix Checkout Crash');
  assert.equal(cleanTitle('Title: Update Genetics Journal'), 'Update Genetics Journal');
  assert.equal(cleanTitle('Investigate Ghost Errors.'), 'Investigate Ghost Errors');
  assert.equal(cleanTitle('  Gym   Workout   Repo  '), 'Gym Workout Repo');
  assert.equal(cleanTitle('“San Francisco Trip Planning”'), 'San Francisco Trip Planning');
  assert.equal(cleanTitle('**Audio Preloading**'), 'Audio Preloading');
});

test('cleanTitle handles a markdown-wrapped or quoted "Title:" preamble', () => {
  assert.equal(cleanTitle('**Title:** "Fix Login Bug"'), 'Fix Login Bug');
  assert.equal(cleanTitle('*Label:* Update Docs'), 'Update Docs');
  assert.equal(cleanTitle('Title: "Quoted Thing"'), 'Quoted Thing');
});

test('cleanTitle takes the first non-empty line when the model adds commentary', () => {
  assert.equal(
    cleanTitle('\n\nEarful Version 2 Design\nThis title captures the design work.'),
    'Earful Version 2 Design',
  );
});

test('cleanTitle returns empty string for empty or whitespace-only input', () => {
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle('   \n  '), '');
});

function stubFetch(responseBody: unknown, init?: { ok?: boolean; status?: number }) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, options: any) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      statusText: 'OK',
      json: async () => responseBody,
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test('generateShortTitle returns the cleaned model title on success', async () => {
  const { fetchImpl, calls } = stubFetch({ response: '"Low Libido Investigation"' });

  const title = await generateShortTitle('Our goal is to determine why my libido has been low...', {
    ollamaUrl: 'http://localhost:11434',
    model: 'llama3.1:8b',
    fetchImpl,
  });

  assert.equal(title, 'Low Libido Investigation');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:11434/api/generate');
  assert.equal(calls[0].body.model, 'llama3.1:8b');
  assert.equal(calls[0].body.stream, false);
  assert.equal(typeof calls[0].body.system, 'string');
  assert.ok(calls[0].body.prompt.startsWith('Our goal'));
});

test('generateShortTitle trims a trailing slash on the Ollama URL', async () => {
  const { fetchImpl, calls } = stubFetch({ response: 'Gym Workout Repo' });
  await generateShortTitle('Start a new private repo for my gym workouts...', {
    ollamaUrl: 'http://localhost:11434/',
    model: 'llama3.1:8b',
    fetchImpl,
  });
  assert.equal(calls[0].url, 'http://localhost:11434/api/generate');
});

test('generateShortTitle returns null for empty or overlong model output', async () => {
  const empty = stubFetch({ response: '   ' });
  assert.equal(
    await generateShortTitle('some long raw title here that needs shortening', {
      ollamaUrl: 'http://x',
      model: 'm',
      fetchImpl: empty.fetchImpl,
    }),
    null,
  );

  const overlong = stubFetch({ response: 'x'.repeat(200) });
  assert.equal(
    await generateShortTitle('some long raw title here that needs shortening', {
      ollamaUrl: 'http://x',
      model: 'm',
      fetchImpl: overlong.fetchImpl,
    }),
    null,
  );
});

test('generateShortTitle accepts output at the length limit and rejects one over', async () => {
  const raw = 'a raw title long enough to be worth shortening';

  const atLimit = stubFetch({ response: 'a'.repeat(80) });
  assert.equal(
    await generateShortTitle(raw, { ollamaUrl: 'http://x', model: 'm', fetchImpl: atLimit.fetchImpl }),
    'a'.repeat(80),
  );

  const overLimit = stubFetch({ response: 'a'.repeat(81) });
  assert.equal(
    await generateShortTitle(raw, { ollamaUrl: 'http://x', model: 'm', fetchImpl: overLimit.fetchImpl }),
    null,
  );
});

test('generateShortTitle returns null for a blank raw title without calling Ollama', async () => {
  const { fetchImpl, calls } = stubFetch({ response: 'nope' });
  const title = await generateShortTitle('   ', {
    ollamaUrl: 'http://x',
    model: 'm',
    fetchImpl,
  });
  assert.equal(title, null);
  assert.equal(calls.length, 0);
});

test('generateShortTitle throws on a non-OK Ollama response so the worker can back off', async () => {
  const { fetchImpl } = stubFetch({}, { ok: false, status: 500 });
  await assert.rejects(
    generateShortTitle('a raw title long enough to be worth shortening', {
      ollamaUrl: 'http://x',
      model: 'm',
      fetchImpl,
    }),
    /Ollama responded 500/,
  );
});
