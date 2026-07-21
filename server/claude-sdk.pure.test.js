import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { extractTokenBudget, mapCliOptionsToSDK } from './claude-sdk.js';

// Pure-function coverage for the two option/usage mappers the SDK bridge runs on
// every turn (#104). Both take plain objects, so they are exercised here without
// spawning the Claude CLI.

// ---------------------------------------------------------------------------
// extractTokenBudget
// ---------------------------------------------------------------------------

test('extractTokenBudget returns null for non-object inputs', () => {
  assert.equal(extractTokenBudget(null), null);
  assert.equal(extractTokenBudget(undefined), null);
  assert.equal(extractTokenBudget('result'), null);
  assert.equal(extractTokenBudget(42), null);
});

test('extractTokenBudget returns null when a message carries no usage at all', () => {
  assert.equal(extractTokenBudget({ type: 'assistant', message: { content: [] } }), null);
});

test('extractTokenBudget sums cache tokens into inputTokens without double counting', () => {
  // The Anthropic usage payload reports the three input counters as disjoint
  // buckets: `input_tokens` explicitly excludes anything read from or written to
  // the prompt cache. So the context-window occupancy is their sum, and the
  // uncached figure must never be counted twice.
  const budget = extractTokenBudget({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 30_000,
        output_tokens: 500,
      },
    },
  });

  assert.equal(budget.inputTokens, 32_100);
  assert.equal(budget.outputTokens, 500);
  assert.equal(budget.cacheCreationTokens, 2_000);
  assert.equal(budget.cacheReadTokens, 30_000);
  assert.equal(budget.cacheTokens, 32_000);
  assert.equal(budget.used, 32_600);
  assert.deepEqual(budget.breakdown, { input: 32_100, output: 500 });
});

test('extractTokenBudget reads result-level usage when there is no nested message', () => {
  const budget = extractTokenBudget({
    type: 'result',
    usage: { input_tokens: 10, output_tokens: 7 },
  });

  assert.equal(budget.inputTokens, 10);
  assert.equal(budget.outputTokens, 7);
  assert.equal(budget.used, 17);
  assert.equal(budget.cacheTokens, 0);
});

test('extractTokenBudget prefers the nested message usage over the result-level one', () => {
  const budget = extractTokenBudget({
    message: { usage: { input_tokens: 11, output_tokens: 0 } },
    usage: { input_tokens: 999, output_tokens: 999 },
  });

  assert.equal(budget.inputTokens, 11);
  assert.equal(budget.used, 11);
});

test('extractTokenBudget accepts camelCase usage keys', () => {
  const budget = extractTokenBudget({
    usage: {
      inputTokens: 5,
      cacheCreationInputTokens: 6,
      cacheReadInputTokens: 7,
      outputTokens: 8,
    },
  });

  assert.equal(budget.inputTokens, 18);
  assert.equal(budget.outputTokens, 8);
  assert.equal(budget.cacheTokens, 13);
});

test('extractTokenBudget coerces missing/garbage counters to zero rather than NaN', () => {
  const budget = extractTokenBudget({ usage: { input_tokens: 'not-a-number' } });

  assert.equal(budget.inputTokens, 0);
  assert.equal(budget.outputTokens, 0);
  assert.equal(budget.used, 0);
  assert.ok(Number.isFinite(budget.used));
});

test('extractTokenBudget defaults the context window to 160k and honours CONTEXT_WINDOW', () => {
  const previous = process.env.CONTEXT_WINDOW;
  delete process.env.CONTEXT_WINDOW;
  try {
    assert.equal(extractTokenBudget({ usage: { input_tokens: 1 } }).total, 160_000);

    process.env.CONTEXT_WINDOW = '1000000';
    assert.equal(extractTokenBudget({ usage: { input_tokens: 1 } }).total, 1_000_000);
  } finally {
    if (previous === undefined) {
      delete process.env.CONTEXT_WINDOW;
    } else {
      process.env.CONTEXT_WINDOW = previous;
    }
  }
});

test('extractTokenBudget falls back to modelUsage when no usage payload exists', () => {
  const budget = extractTokenBudget({
    type: 'result',
    modelUsage: {
      'claude-sonnet-4-6': { inputTokens: 120, outputTokens: 40 },
    },
  });

  assert.equal(budget.inputTokens, 120);
  assert.equal(budget.outputTokens, 40);
  assert.equal(budget.used, 160);
});

test('extractTokenBudget prefers cumulative modelUsage counters', () => {
  const budget = extractTokenBudget({
    modelUsage: {
      'claude-sonnet-4-6': {
        inputTokens: 1,
        outputTokens: 2,
        cumulativeInputTokens: 900,
        cumulativeOutputTokens: 300,
      },
    },
  });

  assert.equal(budget.inputTokens, 900);
  assert.equal(budget.outputTokens, 300);
});

test('extractTokenBudget folds cache tokens into the modelUsage branch too', () => {
  // Regression (#104): the legacy branch used to drop cache creation/read
  // entirely, so the very same run reported a far smaller `used` depending only
  // on which branch the SDK message happened to hit.
  const budget = extractTokenBudget({
    modelUsage: {
      'claude-sonnet-4-6': {
        inputTokens: 100,
        outputTokens: 500,
        cacheCreationInputTokens: 2_000,
        cacheReadInputTokens: 30_000,
      },
    },
  });

  assert.equal(budget.cacheCreationTokens, 2_000);
  assert.equal(budget.cacheReadTokens, 30_000);
  assert.equal(budget.cacheTokens, 32_000);
  assert.equal(budget.inputTokens, 32_100);
  assert.equal(budget.used, 32_600);
});

test('extractTokenBudget reports identical totals for the usage and modelUsage branches', () => {
  const viaUsage = extractTokenBudget({
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 30_000,
      output_tokens: 500,
    },
  });
  const viaModelUsage = extractTokenBudget({
    modelUsage: {
      'claude-sonnet-4-6': {
        inputTokens: 100,
        cacheCreationInputTokens: 2_000,
        cacheReadInputTokens: 30_000,
        outputTokens: 500,
      },
    },
  });

  assert.deepEqual(viaModelUsage, viaUsage);
});

test('extractTokenBudget sums every model in modelUsage, not just the first', () => {
  // Regression (#104): a run that delegated to a subagent records one entry per
  // model. Reading `Object.keys(modelUsage)[0]` reported whichever model was
  // inserted first — often the tiny subagent — as the whole run's usage.
  const budget = extractTokenBudget({
    modelUsage: {
      'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5 },
      'claude-sonnet-4-6': { inputTokens: 4_000, outputTokens: 1_000 },
    },
  });

  assert.equal(budget.inputTokens, 4_010);
  assert.equal(budget.outputTokens, 1_005);
  assert.equal(budget.used, 5_015);
});

test('extractTokenBudget skips malformed modelUsage entries but keeps the valid ones', () => {
  const budget = extractTokenBudget({
    modelUsage: {
      broken: null,
      alsoBroken: 'nope',
      'claude-sonnet-4-6': { inputTokens: 42, outputTokens: 8 },
    },
  });

  assert.equal(budget.inputTokens, 42);
  assert.equal(budget.outputTokens, 8);
});

test('extractTokenBudget returns null when modelUsage has no usable entries', () => {
  assert.equal(extractTokenBudget({ modelUsage: {} }), null);
  assert.equal(extractTokenBudget({ modelUsage: { 'claude-sonnet-4-6': null } }), null);
});

// ---------------------------------------------------------------------------
// mapCliOptionsToSDK
// ---------------------------------------------------------------------------

test('mapCliOptionsToSDK produces safe defaults with no options at all', () => {
  const sdkOptions = mapCliOptionsToSDK();

  assert.deepEqual(sdkOptions.allowedTools, []);
  assert.deepEqual(sdkOptions.disallowedTools, []);
  assert.deepEqual(sdkOptions.tools, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(sdkOptions.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(sdkOptions.settingSources, ['project', 'user', 'local']);
  assert.equal(sdkOptions.model, CLAUDE_FALLBACK_MODELS.DEFAULT);
  assert.equal('permissionMode' in sdkOptions, false, 'no permission mode must be forced by default');
  assert.equal('resume' in sdkOptions, false);
  assert.equal('cwd' in sdkOptions, false);
  assert.equal('effort' in sdkOptions, false);
});

test('mapCliOptionsToSDK forwards the host environment to the subprocess', () => {
  // Since SDK 0.2.113 `options.env` *replaces* process.env instead of overlaying
  // it, so anything the host set (ANTHROPIC_BASE_URL, proxies, …) has to be
  // copied across explicitly or the CLI runs with a bare environment.
  const previous = process.env.CLOUDCLI_TEST_ENV_PASSTHROUGH;
  process.env.CLOUDCLI_TEST_ENV_PASSTHROUGH = 'carried-through';
  try {
    const sdkOptions = mapCliOptionsToSDK({});
    assert.equal(sdkOptions.env.CLOUDCLI_TEST_ENV_PASSTHROUGH, 'carried-through');
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDCLI_TEST_ENV_PASSTHROUGH;
    } else {
      process.env.CLOUDCLI_TEST_ENV_PASSTHROUGH = previous;
    }
  }
});

test('mapCliOptionsToSDK always resolves an executable path for the CLI', () => {
  const sdkOptions = mapCliOptionsToSDK({});
  assert.equal(typeof sdkOptions.pathToClaudeCodeExecutable, 'string');
  assert.ok(sdkOptions.pathToClaudeCodeExecutable.length > 0);
});

test('mapCliOptionsToSDK passes cwd and resumes an existing session id', () => {
  const sdkOptions = mapCliOptionsToSDK({ cwd: '/repo/app', sessionId: 'session-abc' });

  assert.equal(sdkOptions.cwd, '/repo/app');
  assert.equal(sdkOptions.resume, 'session-abc');
});

test('mapCliOptionsToSDK treats the "default" permission mode as "do not set one"', () => {
  assert.equal('permissionMode' in mapCliOptionsToSDK({ permissionMode: 'default' }), false);
  assert.equal(mapCliOptionsToSDK({ permissionMode: 'acceptEdits' }).permissionMode, 'acceptEdits');
});

test('mapCliOptionsToSDK maps skipPermissions to bypassPermissions', () => {
  const sdkOptions = mapCliOptionsToSDK({
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true },
  });

  assert.equal(sdkOptions.permissionMode, 'bypassPermissions');
});

test('mapCliOptionsToSDK never lets skipPermissions escape plan mode', () => {
  // Plan mode is a read-only sandbox; letting "skip permissions" upgrade it to
  // bypassPermissions would let a planning turn edit the working tree.
  const sdkOptions = mapCliOptionsToSDK({
    permissionMode: 'plan',
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true },
  });

  assert.equal(sdkOptions.permissionMode, 'plan');
});

test('mapCliOptionsToSDK injects the plan-mode tool set on top of the caller allow-list', () => {
  const sdkOptions = mapCliOptionsToSDK({
    permissionMode: 'plan',
    toolsSettings: { allowedTools: ['Grep'], disallowedTools: [], skipPermissions: false },
  });

  assert.deepEqual(sdkOptions.allowedTools, [
    'Grep',
    'Read',
    'Task',
    'exit_plan_mode',
    'TodoRead',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
  ]);
});

test('mapCliOptionsToSDK does not duplicate plan tools already in the allow-list', () => {
  const sdkOptions = mapCliOptionsToSDK({
    permissionMode: 'plan',
    toolsSettings: { allowedTools: ['Read', 'WebSearch'], disallowedTools: [], skipPermissions: false },
  });

  assert.equal(sdkOptions.allowedTools.filter((tool) => tool === 'Read').length, 1);
  assert.equal(sdkOptions.allowedTools.filter((tool) => tool === 'WebSearch').length, 1);
});

test('mapCliOptionsToSDK leaves the allow-list untouched outside plan mode', () => {
  const sdkOptions = mapCliOptionsToSDK({
    toolsSettings: { allowedTools: ['Grep'], disallowedTools: ['Bash'], skipPermissions: false },
  });

  assert.deepEqual(sdkOptions.allowedTools, ['Grep']);
  assert.deepEqual(sdkOptions.disallowedTools, ['Bash']);
});

test('mapCliOptionsToSDK does not mutate the caller tool settings', () => {
  const toolsSettings = { allowedTools: ['Grep'], disallowedTools: [], skipPermissions: false };
  mapCliOptionsToSDK({ permissionMode: 'plan', toolsSettings });

  assert.deepEqual(toolsSettings.allowedTools, ['Grep']);
});

test('mapCliOptionsToSDK resolves an effort the selected model supports', () => {
  const sdkOptions = mapCliOptionsToSDK({ model: 'sonnet', effort: 'low' });
  assert.equal(sdkOptions.effort, 'low');
});

test('mapCliOptionsToSDK drops an effort the selected model does not support', () => {
  // "sonnet" has no xhigh tier; forwarding it would make the CLI reject the run.
  assert.equal('effort' in mapCliOptionsToSDK({ model: 'sonnet', effort: 'xhigh' }), false);
  assert.equal(mapCliOptionsToSDK({ model: 'fable', effort: 'xhigh' }).effort, 'xhigh');
});

test('mapCliOptionsToSDK treats the "default" effort as unset', () => {
  assert.equal('effort' in mapCliOptionsToSDK({ model: 'sonnet', effort: 'default' }), false);
});

test('mapCliOptionsToSDK drops the effort for an unknown model', () => {
  assert.equal('effort' in mapCliOptionsToSDK({ model: 'not-a-real-model', effort: 'high' }), false);
});

test('mapCliOptionsToSDK resolves effort against a caller-supplied model catalogue', () => {
  const sdkOptions = mapCliOptionsToSDK({
    model: 'custom-model',
    effort: 'turbo',
    effortModels: {
      OPTIONS: [{ value: 'custom-model', effort: { values: [{ value: 'turbo' }] } }],
      DEFAULT: 'custom-model',
    },
  });

  assert.equal(sdkOptions.effort, 'turbo');
});
