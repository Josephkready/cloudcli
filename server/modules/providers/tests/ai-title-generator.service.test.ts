import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTitleRequestBody,
  cleanTitle,
  generateShortTitle,
} from '@/modules/providers/services/ai-title-generator.service.js';

const OPTIONS = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-5-nano',
  apiKey: 'test-key',
  zdr: true,
  reasoningEffort: 'minimal',
  maxTokensParam: 'max_completion_tokens',
};

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

test('buildTitleRequestBody pins ZDR routing and requires parameter support', () => {
  const body = buildTitleRequestBody('raw title', OPTIONS);

  assert.deepEqual(body.provider, { zdr: true, require_parameters: true });
  assert.deepEqual(body.reasoning, { effort: 'minimal' });
  assert.equal(body.model, 'openai/gpt-5-nano');
});

test('buildTitleRequestBody sends no sampling parameters', () => {
  // Regression guard for a live 404: under `require_parameters: true` every
  // parameter the endpoint does not advertise filters it out of the pool, and
  // the default model's ZDR endpoint advertises no sampling parameters at all —
  // so a stray temperature/top_p empties the pool and fails every request.
  const body = buildTitleRequestBody('raw title', OPTIONS);

  assert.equal('temperature' in body, false);
  assert.equal('top_p' in body, false);
});

test('buildTitleRequestBody names the output cap parameter per the model family', () => {
  // openai/gpt-5-nano's ZDR endpoint (Azure) advertises max_completion_tokens and
  // NOT max_tokens; most non-OpenAI models are the other way round. Sending the
  // wrong name 404s under require_parameters instead of being ignored.
  const openai = buildTitleRequestBody('raw title', OPTIONS);
  assert.equal(typeof openai.max_completion_tokens, 'number');
  assert.equal('max_tokens' in openai, false);

  const other = buildTitleRequestBody('raw title', { ...OPTIONS, maxTokensParam: 'max_tokens' });
  assert.equal(typeof other.max_tokens, 'number');
  assert.equal('max_completion_tokens' in other, false);
});

test('buildTitleRequestBody omits the provider block when ZDR is off', () => {
  const body = buildTitleRequestBody('raw title', { ...OPTIONS, zdr: false });
  assert.equal('provider' in body, false);
});

test('buildTitleRequestBody omits reasoning when no effort is configured', () => {
  // Needed for models whose endpoints do not support `reasoning` — with the
  // provider block in play, an unsupported parameter is a hard routing failure.
  const body = buildTitleRequestBody('raw title', { ...OPTIONS, reasoningEffort: '' });
  assert.equal('reasoning' in body, false);
});

function stubFetch(
  responseBody: unknown,
  init?: { ok?: boolean; status?: number; text?: string },
) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, options: any) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      statusText: 'OK',
      json: async () => responseBody,
      text: async () => init?.text ?? JSON.stringify(responseBody),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Shapes a minimal chat-completions success response. */
function completion(content: string, finishReason = 'stop') {
  return { choices: [{ finish_reason: finishReason, message: { content } }] };
}

test('generateShortTitle returns the cleaned model title on success', async () => {
  const { fetchImpl, calls } = stubFetch(completion('"Low Libido Investigation"'));

  const title = await generateShortTitle('Our goal is to determine why my libido has been low...', {
    ...OPTIONS,
    fetchImpl,
  });

  assert.equal(title, 'Low Libido Investigation');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'openai/gpt-5-nano');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.equal(calls[0].body.messages[1].role, 'user');
  assert.ok(calls[0].body.messages[1].content.startsWith('Our goal'));
});

test('generateShortTitle trims a trailing slash on the base URL', async () => {
  const { fetchImpl, calls } = stubFetch(completion('Gym Workout Repo'));
  await generateShortTitle('Start a new private repo for my gym workouts...', {
    ...OPTIONS,
    baseUrl: 'https://openrouter.ai/api/v1/',
    fetchImpl,
  });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
});

test('generateShortTitle returns null for empty or overlong model output', async () => {
  const empty = stubFetch(completion('   '));
  assert.equal(
    await generateShortTitle('some long raw title here that needs shortening', {
      ...OPTIONS,
      fetchImpl: empty.fetchImpl,
    }),
    null,
  );

  const overlong = stubFetch(completion('x'.repeat(200)));
  assert.equal(
    await generateShortTitle('some long raw title here that needs shortening', {
      ...OPTIONS,
      fetchImpl: overlong.fetchImpl,
    }),
    null,
  );
});

test('generateShortTitle returns null for a missing or non-string content field', async () => {
  const noChoices = stubFetch({ choices: [] });
  assert.equal(
    await generateShortTitle('a raw title long enough to be worth shortening', {
      ...OPTIONS,
      fetchImpl: noChoices.fetchImpl,
    }),
    null,
  );

  const nullContent = stubFetch({ choices: [{ message: { content: null } }] });
  assert.equal(
    await generateShortTitle('a raw title long enough to be worth shortening', {
      ...OPTIONS,
      fetchImpl: nullContent.fetchImpl,
    }),
    null,
  );

  // Exercises the `typeof content === 'string'` guard itself, not just nullishness.
  const numericContent = stubFetch({ choices: [{ message: { content: 42 } }] });
  assert.equal(
    await generateShortTitle('a raw title long enough to be worth shortening', {
      ...OPTIONS,
      fetchImpl: numericContent.fetchImpl,
    }),
    null,
  );
});

test('generateShortTitle returns null when the reply was truncated by the token cap', async () => {
  // finish_reason=length means the budget ran out — the "title" is a fragment,
  // or the model spent it all on reasoning. Storing either would be worse than
  // keeping the raw title.
  const { fetchImpl } = stubFetch(completion('Fix The Checkout Flow That', 'length'));
  assert.equal(
    await generateShortTitle('a raw title long enough to be worth shortening', {
      ...OPTIONS,
      fetchImpl,
    }),
    null,
  );
});

test('generateShortTitle accepts output at the length limit and rejects one over', async () => {
  const raw = 'a raw title long enough to be worth shortening';

  const atLimit = stubFetch(completion('a'.repeat(80)));
  assert.equal(await generateShortTitle(raw, { ...OPTIONS, fetchImpl: atLimit.fetchImpl }), 'a'.repeat(80));

  const overLimit = stubFetch(completion('a'.repeat(81)));
  assert.equal(await generateShortTitle(raw, { ...OPTIONS, fetchImpl: overLimit.fetchImpl }), null);
});

test('generateShortTitle returns null for a blank raw title without calling the API', async () => {
  const { fetchImpl, calls } = stubFetch(completion('nope'));
  const title = await generateShortTitle('   ', { ...OPTIONS, fetchImpl });
  assert.equal(title, null);
  assert.equal(calls.length, 0);
});

test('generateShortTitle throws on a non-OK response, quoting the body so misrouting is diagnosable', async () => {
  const { fetchImpl } = stubFetch(
    {},
    {
      ok: false,
      status: 404,
      text: '{"error":{"message":"No endpoints found matching your data policy (Zero data retention)."}}',
    },
  );
  await assert.rejects(
    generateShortTitle('a raw title long enough to be worth shortening', { ...OPTIONS, fetchImpl }),
    /Title API responded 404 .*Zero data retention/,
  );
});

test('generateShortTitle throws when a 200 response carries an error payload', async () => {
  // OpenRouter reports some upstream failures inside a 200; treating that as an
  // empty completion would burn the row instead of backing off.
  const { fetchImpl } = stubFetch({ error: { message: 'upstream provider timed out' } });
  await assert.rejects(
    generateShortTitle('a raw title long enough to be worth shortening', { ...OPTIONS, fetchImpl }),
    /upstream provider timed out/,
  );
});

test('generateShortTitle collapses newlines out of remote error text', async () => {
  // The error text reaches a single `[AI titles]` console.warn line, so a remote
  // body containing newlines could otherwise forge extra log entries under that
  // prefix. Both error paths — HTTP-level and 200-with-error — must collapse.
  const injection = 'Unauthorized\n[AI titles] Title backend reachable again, resuming.';

  const inPayload = stubFetch({ error: { message: injection } });
  await assert.rejects(
    generateShortTitle('a raw title long enough to be worth shortening', {
      ...OPTIONS,
      fetchImpl: inPayload.fetchImpl,
    }),
    (error: Error) => !error.message.includes('\n') && error.message.includes('Unauthorized'),
  );

  const inBody = stubFetch({}, { ok: false, status: 401, text: injection });
  await assert.rejects(
    generateShortTitle('a raw title long enough to be worth shortening', {
      ...OPTIONS,
      fetchImpl: inBody.fetchImpl,
    }),
    (error: Error) => !error.message.includes('\n'),
  );
});

test('generateShortTitle aborts the request when it outruns the timeout', async () => {
  // Also guards the clearTimeout wiring: a leaked timer would keep the process
  // alive and make this test hang rather than fail.
  const fetchImpl = ((url: string, options: any) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;

  await assert.rejects(
    generateShortTitle('a raw title long enough to be worth shortening', {
      ...OPTIONS,
      timeoutMs: 1,
      fetchImpl,
    }),
    /aborted/,
  );
});
