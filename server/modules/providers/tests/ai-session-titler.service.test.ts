import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseApiKeyFile,
  processTitleBatch,
  readConfig,
  startAiSessionTitler,
  stopAiSessionTitler,
  type TitleBatchDeps,
} from '@/modules/providers/services/ai-session-titler.service.js';

/** Every env var readConfig looks at, so each test starts from a known state. */
const TITLER_ENV_VARS = [
  'CLOUDCLI_AI_TITLES_ENABLED',
  'CLOUDCLI_AI_TITLES_BASE_URL',
  'CLOUDCLI_AI_TITLES_MODEL',
  'CLOUDCLI_AI_TITLES_API_KEY',
  'CLOUDCLI_AI_TITLES_API_KEY_FILE',
  'CLOUDCLI_AI_TITLES_ZDR',
  'CLOUDCLI_AI_TITLES_REASONING_EFFORT',
  'CLOUDCLI_AI_TITLES_MAX_TOKENS_PARAM',
  'CLOUDCLI_AI_TITLES_INTERVAL_MS',
  'CLOUDCLI_AI_TITLES_BATCH',
  'CLOUDCLI_AI_TITLES_MIN_LEN',
];

/** Runs `body` with the titler env cleared and `env` applied, then restores. */
function withEnv(env: Record<string, string>, body: () => void): void {
  const saved = new Map(TITLER_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of TITLER_ENV_VARS) {
    delete process.env[name];
  }
  Object.assign(process.env, env);

  try {
    body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/**
 * Records every collaborator call so the batch's ordering/marking invariants can
 * be asserted. `generate` is driven by a per-session_id script.
 */
function makeDeps(script: Record<string, string | null | Error>): {
  deps: TitleBatchDeps;
  persisted: Array<{ id: string; title: string }>;
  broadcasts: string[];
  generatedFor: string[];
} {
  const persisted: Array<{ id: string; title: string }> = [];
  const broadcasts: string[] = [];
  const generatedFor: string[] = [];

  const deps: TitleBatchDeps = {
    generate: async (raw) => {
      generatedFor.push(raw);
      const outcome = script[raw];
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome ?? null;
    },
    persist: (id, title) => {
      persisted.push({ id, title });
    },
    broadcast: async (id) => {
      broadcasts.push(id);
    },
  };

  return { deps, persisted, broadcasts, generatedFor };
}

test('processTitleBatch rewrites and broadcasts a good title', async () => {
  const { deps, persisted, broadcasts } = makeDeps({ 'raw one': 'Short One' });
  const result = await processTitleBatch([{ session_id: 's1', custom_name: 'raw one' }], deps);

  assert.deepEqual(persisted, [{ id: 's1', title: 'Short One' }]);
  assert.deepEqual(broadcasts, ['s1']);
  assert.deepEqual(result, { rewritten: 1, attempted: 1, failed: false });
});

test('processTitleBatch marks a null-result row done (keeping the raw title) without broadcasting', async () => {
  // Guards the "a stubborn row can't starve the backfill" invariant: an
  // unusable model result must still persist name_source='ai' so the row is
  // not re-picked forever.
  const { deps, persisted, broadcasts } = makeDeps({ 'raw two': null });
  const result = await processTitleBatch([{ session_id: 's2', custom_name: 'raw two' }], deps);

  assert.deepEqual(persisted, [{ id: 's2', title: 'raw two' }]);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(result, { rewritten: 0, attempted: 1, failed: false });
});

test('processTitleBatch does not broadcast when the model echoes the raw title', async () => {
  const { deps, persisted, broadcasts } = makeDeps({ 'raw same': 'raw same' });
  const result = await processTitleBatch([{ session_id: 's3', custom_name: 'raw same' }], deps);

  assert.deepEqual(persisted, [{ id: 's3', title: 'raw same' }]);
  assert.deepEqual(broadcasts, []);
  assert.equal(result.rewritten, 0);
});

test('processTitleBatch skips rows with no custom_name without attempting generation', async () => {
  const { deps, persisted, generatedFor } = makeDeps({});
  const result = await processTitleBatch([{ session_id: 's4', custom_name: null }], deps);

  assert.deepEqual(persisted, []);
  assert.deepEqual(generatedFor, []);
  assert.deepEqual(result, { rewritten: 0, attempted: 0, failed: false });
});

test('processTitleBatch aborts the rest of the batch when generation throws', async () => {
  const { deps, persisted, generatedFor } = makeDeps({
    'raw a': 'Title A',
    'raw b': new Error('Title API responded 401 Unauthorized'),
    'raw c': 'Title C',
  });

  const result = await processTitleBatch(
    [
      { session_id: 'a', custom_name: 'raw a' },
      { session_id: 'b', custom_name: 'raw b' },
      { session_id: 'c', custom_name: 'raw c' },
    ],
    deps,
  );

  // First row succeeded; the throw on the second stops processing before the third.
  assert.deepEqual(persisted, [{ id: 'a', title: 'Title A' }]);
  assert.deepEqual(generatedFor, ['raw a', 'raw b']);
  assert.deepEqual(result, {
    rewritten: 1,
    attempted: 2,
    failed: true,
    // Carried so the backoff log can distinguish a bad key from a routing
    // failure — the reason is logged only once per failure streak.
    failureReason: 'Title API responded 401 Unauthorized',
  });
});

test('parseApiKeyFile reads only the named key out of a shared env file', () => {
  // The point of reading one key (rather than sourcing the file) is that a
  // deployment can point at a credential file it shares with other services
  // without importing every unrelated secret in it.
  const contents = [
    '# shared credentials',
    'SOME_OTHER_SECRET=do-not-take-this',
    'OPENROUTER_API_KEY=sk-or-v1-abc123',
    'ANOTHER=nope',
  ].join('\n');

  assert.equal(parseApiKeyFile(contents), 'sk-or-v1-abc123');
});

test('parseApiKeyFile prefers the cloudcli-specific key over the generic one', () => {
  const contents = 'OPENROUTER_API_KEY=shared-key\nCLOUDCLI_AI_TITLES_API_KEY=specific-key\n';
  assert.equal(parseApiKeyFile(contents), 'specific-key');
});

test('parseApiKeyFile tolerates quotes and surrounding whitespace', () => {
  assert.equal(parseApiKeyFile('  OPENROUTER_API_KEY="sk-quoted"  '), 'sk-quoted');
  assert.equal(parseApiKeyFile("OPENROUTER_API_KEY='sk-single'"), 'sk-single');
});

test('parseApiKeyFile returns empty string when the key is absent or blank', () => {
  assert.equal(parseApiKeyFile('UNRELATED=1\n'), '');
  assert.equal(parseApiKeyFile('OPENROUTER_API_KEY=\n'), '');
  assert.equal(parseApiKeyFile(''), '');
});

test('parseApiKeyFile does not match a key that is merely a suffix of another name', () => {
  assert.equal(parseApiKeyFile('MY_OPENROUTER_API_KEY=not-ours\n'), '');
});

test('parseApiKeyFile accepts a shell-style `export` prefix', () => {
  // A file meant to be sourced by bash uses `export`; a systemd EnvironmentFile
  // does not. Missing this reads as "no API key configured", with no hint why.
  assert.equal(parseApiKeyFile('export OPENROUTER_API_KEY=sk-exported\n'), 'sk-exported');
});

test('parseApiKeyFile keeps scanning past a blank assignment of the same key', () => {
  assert.equal(parseApiKeyFile('OPENROUTER_API_KEY=\nOPENROUTER_API_KEY=sk-real\n'), 'sk-real');
});

test('readConfig defaults to ZDR-pinned OpenRouter with minimal reasoning', () => {
  withEnv({ CLOUDCLI_AI_TITLES_ENABLED: 'true' }, () => {
    const config = readConfig();

    assert.equal(config.enabled, true);
    assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(config.model, 'openai/gpt-5-nano');
    assert.equal(config.zdr, true);
    assert.equal(config.reasoningEffort, 'minimal');
    assert.equal(config.maxTokensParam, 'max_completion_tokens');
    assert.deepEqual(
      { intervalMs: config.intervalMs, batchSize: config.batchSize, minLength: config.minLength },
      { intervalMs: 5_000, batchSize: 5, minLength: 60 },
    );
  });
});

test('readConfig treats ZDR as on unless it is exactly "false"', () => {
  // Default-on is the privacy posture: a typo must not silently unpin routing.
  withEnv({ CLOUDCLI_AI_TITLES_ZDR: 'false' }, () => assert.equal(readConfig().zdr, false));
  withEnv({ CLOUDCLI_AI_TITLES_ZDR: 'true' }, () => assert.equal(readConfig().zdr, true));
  withEnv({ CLOUDCLI_AI_TITLES_ZDR: 'no' }, () => assert.equal(readConfig().zdr, true));
  withEnv({ CLOUDCLI_AI_TITLES_ZDR: '' }, () => assert.equal(readConfig().zdr, true));
});

test('readConfig distinguishes an unset reasoning effort from an explicitly empty one', () => {
  // Unset means "use the default"; empty means "omit the parameter", which is
  // required for models whose endpoints do not support it — under
  // require_parameters an unsupported parameter is a hard 404, not a silent drop.
  withEnv({}, () => assert.equal(readConfig().reasoningEffort, 'minimal'));
  withEnv({ CLOUDCLI_AI_TITLES_REASONING_EFFORT: '' }, () =>
    assert.equal(readConfig().reasoningEffort, ''),
  );
  withEnv({ CLOUDCLI_AI_TITLES_REASONING_EFFORT: '  ' }, () =>
    assert.equal(readConfig().reasoningEffort, ''),
  );
  withEnv({ CLOUDCLI_AI_TITLES_REASONING_EFFORT: 'low' }, () =>
    assert.equal(readConfig().reasoningEffort, 'low'),
  );
});

test('readConfig falls back to the default output-cap parameter when blank', () => {
  // Unlike reasoning effort, an empty value here is meaningless rather than
  // meaningful — the request always needs some cap parameter name.
  withEnv({ CLOUDCLI_AI_TITLES_MAX_TOKENS_PARAM: '' }, () =>
    assert.equal(readConfig().maxTokensParam, 'max_completion_tokens'),
  );
  withEnv({ CLOUDCLI_AI_TITLES_MAX_TOKENS_PARAM: 'max_tokens' }, () =>
    assert.equal(readConfig().maxTokensParam, 'max_tokens'),
  );
});

test('readConfig ignores non-positive or malformed numeric settings', () => {
  withEnv(
    {
      CLOUDCLI_AI_TITLES_INTERVAL_MS: 'soon',
      CLOUDCLI_AI_TITLES_BATCH: '0',
      CLOUDCLI_AI_TITLES_MIN_LEN: '-5',
    },
    () => {
      const config = readConfig();
      assert.equal(config.intervalMs, 5_000);
      assert.equal(config.batchSize, 5);
      assert.equal(config.minLength, 60);
    },
  );
});

test('readConfig prefers the API key env var over the key file', () => {
  withEnv(
    {
      CLOUDCLI_AI_TITLES_API_KEY: 'from-env',
      CLOUDCLI_AI_TITLES_API_KEY_FILE: '/nonexistent/cloudcli.env',
    },
    () => assert.equal(readConfig().apiKey, 'from-env'),
  );
});

test('readConfig yields no key (rather than throwing) when the key file is unreadable', () => {
  withEnv({ CLOUDCLI_AI_TITLES_API_KEY_FILE: '/nonexistent/cloudcli.env' }, () => {
    assert.equal(readConfig().apiKey, '');
  });
});

test('startAiSessionTitler refuses to start when enabled without an API key', () => {
  // The guard exists so a misconfigured deploy logs one actionable line instead
  // of backing off forever against requests that can only fail.
  const warnings: string[] = [];
  const logs: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (message?: unknown) => void warnings.push(String(message));
  console.log = (message?: unknown) => void logs.push(String(message));

  try {
    withEnv({ CLOUDCLI_AI_TITLES_ENABLED: 'true' }, () => startAiSessionTitler());
  } finally {
    console.warn = realWarn;
    console.log = realLog;
    stopAiSessionTitler();
  }

  assert.ok(warnings.some((line) => line.includes('no API key')));
  assert.equal(logs.some((line) => line.includes('Enabled')), false);
});

test('startAiSessionTitler stays off, and reads no key file, when disabled', () => {
  // The enabled check runs before the key file is read, so a disabled feature
  // cannot warn about a path nothing was going to use.
  const warnings: string[] = [];
  const logs: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (message?: unknown) => void warnings.push(String(message));
  console.log = (message?: unknown) => void logs.push(String(message));

  try {
    withEnv({ CLOUDCLI_AI_TITLES_API_KEY_FILE: '/nonexistent/cloudcli.env' }, () =>
      startAiSessionTitler(),
    );
  } finally {
    console.warn = realWarn;
    console.log = realLog;
    stopAiSessionTitler();
  }

  assert.ok(logs.some((line) => line.includes('Disabled')));
  assert.deepEqual(warnings, []);
});

test('processTitleBatch continues the batch when a broadcast fails', async () => {
  const { deps, persisted, broadcasts } = makeDeps({ 'raw x': 'Title X', 'raw y': 'Title Y' });
  deps.broadcast = async (id) => {
    broadcasts.push(id);
    if (id === 'x') {
      throw new Error('client gone');
    }
  };

  const result = await processTitleBatch(
    [
      { session_id: 'x', custom_name: 'raw x' },
      { session_id: 'y', custom_name: 'raw y' },
    ],
    deps,
  );

  // Both titles persisted and counted even though x's broadcast threw.
  assert.deepEqual(persisted, [
    { id: 'x', title: 'Title X' },
    { id: 'y', title: 'Title Y' },
  ]);
  assert.deepEqual(broadcasts, ['x', 'y']);
  assert.deepEqual(result, { rewritten: 2, attempted: 2, failed: false });
});
