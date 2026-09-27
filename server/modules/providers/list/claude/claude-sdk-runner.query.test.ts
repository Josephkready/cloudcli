import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { ProviderModelsDefinition } from '@/shared/types.js';

// This file drives server/modules/providers/list/claude/claude-sdk-runner.ts,
// the biggest uncovered chunk of which is queryClaudeSDK's own body — the SDK
// spawns a real `claude` CLI subprocess under the hood (confirmed via
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs: it shells out honoring
// `pathToClaudeCodeExecutable`, using `--input-format/--output-format
// stream-json`). Rather than reimplementing that wire protocol, this test
// intercepts the SDK's exported `query()` function directly with node:test's
// `mock.module` (needs `--experimental-test-module-mocks`, added to
// package.json's test:server / test:server:coverage scripts for this PR) —
// `query` is a true ESM named export and cannot be monkeypatched any other
// way (a plain property assignment throws on an ESM namespace object).
//
// `mock.module` replaces the module for the whole process once registered, so
// every test below drives its own fake generator via a module-level relay
// function that each test swaps out immediately before calling into
// queryClaudeSDK.

let capturedQueryArgs: any = null;
let queryImpl: (args: any) => AsyncGenerator<any> = async function* defaultImpl() {};

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (args: any) => {
      capturedQueryArgs = args;
      return queryImpl(args);
    },
  },
});

const { queryClaudeSDK, mapCliOptionsToSDK, extractTokenBudget, isMainThreadMessage } = await import(
  './claude-sdk-runner.js'
);
const { closeConnection, initializeDatabase, userDb } = await import('@/modules/database/index.js');

const tempDirectory = await mkdtemp(path.join('/var/tmp', 'claude-sdk-runner-'));
process.env.HOME = tempDirectory;
process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
process.env.VITE_AUTH_DISABLED = 'true';
closeConnection();
await initializeDatabase();
// notifyUserIfEnabled (invoked from every queryClaudeSDK exit path) looks the
// user up by id — a real, seeded row is required or every run fails with a
// FOREIGN KEY constraint deep inside notification preferences.
const seededUser = userDb.getFirstUser();
if (!seededUser) {
  throw new Error('expected initializeDatabase() to seed a default user in auth-disabled mode');
}
const TEST_USER_ID = seededUser.id;

test.after(async () => {
  closeConnection();
  await rm(tempDirectory, { recursive: true, force: true });
});

function makeWriter() {
  const sent: any[] = [];
  let abortHandler: (() => Promise<boolean> | boolean) | null = null;
  let cleared = 0;
  let sessionId: string | null = null;
  const blocked: boolean[] = [];
  return {
    userId: TEST_USER_ID,
    sent,
    send: (message: any) => sent.push(message),
    setSessionId: (id: string) => { sessionId = id; },
    getSessionId: () => sessionId,
    setAbortHandler: (handler: () => Promise<boolean> | boolean) => { abortHandler = handler; },
    clearAbortHandler: () => { cleared += 1; },
    setBlocked: (value: boolean) => blocked.push(value),
    isRunActive: () => true,
    getAbortHandler: () => abortHandler,
    getClearedCount: () => cleared,
    getBlockedCalls: () => blocked,
  } as any;
}

async function* asyncGeneratorOf(...messages: any[]): AsyncGenerator<any> {
  for (const message of messages) {
    yield message;
  }
}

test('mapCliOptionsToSDK: default options, forwarded env, and executable path', () => {
  const options = mapCliOptionsToSDK({});
  assert.equal(options.env.PATH, process.env.PATH);
  assert.equal(typeof options.pathToClaudeCodeExecutable, 'string');
  assert.equal(options.permissionMode, undefined);
  assert.deepEqual(options.allowedTools, []);
  assert.deepEqual(options.disallowedTools, []);
  assert.equal(options.tools.preset, 'claude_code');
  assert.equal(options.resume, undefined);
});

test('mapCliOptionsToSDK: cwd, non-default permissionMode, and resume are forwarded', () => {
  const options = mapCliOptionsToSDK({ cwd: '/work', permissionMode: 'acceptEdits', sessionId: 'sess-1' });
  assert.equal(options.cwd, '/work');
  assert.equal(options.permissionMode, 'acceptEdits');
  assert.equal(options.resume, 'sess-1');
});

test('mapCliOptionsToSDK: plan mode adds the plan tool allowlist and does not force bypassPermissions', () => {
  const options = mapCliOptionsToSDK({
    permissionMode: 'plan',
    toolsSettings: { skipPermissions: true, allowedTools: ['Read'] },
  });
  assert.equal(options.permissionMode, 'plan');
  for (const tool of ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch']) {
    assert.ok(options.allowedTools.includes(tool), `expected ${tool} in plan-mode allowedTools`);
  }
  // skipPermissions is set, but permissionMode === 'plan' skips the forced bypass (see source comment).
  assert.notEqual(options.permissionMode, 'bypassPermissions');
});

test('mapCliOptionsToSDK: skipPermissions forces bypassPermissions outside plan mode', () => {
  const options = mapCliOptionsToSDK({ toolsSettings: { skipPermissions: true } });
  assert.equal(options.permissionMode, 'bypassPermissions');
});

test('mapCliOptionsToSDK: effort is only forwarded when the model supports it', () => {
  const models: ProviderModelsDefinition = {
    DEFAULT: 'model-a',
    OPTIONS: [
      { value: 'model-a', label: 'A', effort: { values: [{ value: 'high', label: 'High' }] } },
    ],
  } as any;

  const supported = mapCliOptionsToSDK({ model: 'model-a', effort: 'high', effortModels: models });
  assert.equal(supported.effort, 'high');

  const unsupported = mapCliOptionsToSDK({ model: 'model-a', effort: 'nonexistent', effortModels: models });
  assert.equal(unsupported.effort, undefined);

  const defaultEffort = mapCliOptionsToSDK({ model: 'model-a', effort: 'default', effortModels: models });
  assert.equal(defaultEffort.effort, undefined);
});

test('extractTokenBudget: reads message.usage, falls back to modelUsage, and returns null otherwise', () => {
  const fromMessageUsage = extractTokenBudget({
    message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
  });
  assert.equal(fromMessageUsage?.inputTokens, 13);
  assert.equal(fromMessageUsage?.outputTokens, 5);

  assert.equal(extractTokenBudget({}), null);
  assert.equal(extractTokenBudget(null), null);
});

test('isMainThreadMessage: false only when parent_tool_use_id is present', () => {
  assert.equal(isMainThreadMessage({ type: 'assistant' }), true);
  assert.equal(isMainThreadMessage({ type: 'assistant', parent_tool_use_id: 'abc' }), false);
  assert.equal(isMainThreadMessage(null), false);
});

test('queryClaudeSDK: a brand-new session streams assistant text and sends session_created once', async () => {
  queryImpl = async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'new-sess-1' };
    yield {
      type: 'assistant',
      session_id: 'new-sess-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] },
    };
    yield { type: 'result', subtype: 'success', session_id: 'new-sess-1', result: 'Hello there' };
  };

  const writer = makeWriter();
  await queryClaudeSDK('hi', {}, writer);

  assert.ok(capturedQueryArgs.options.pathToClaudeCodeExecutable, 'query() should receive the resolved CLI path');
  const kinds = writer.sent.map((m: any) => m.kind);
  assert.ok(kinds.includes('session_created'), `expected session_created in ${JSON.stringify(kinds)}`);
  const sessionCreatedFrames = writer.sent.filter((m: any) => m.kind === 'session_created');
  assert.equal(sessionCreatedFrames.length, 1);
  assert.ok(kinds.includes('complete'), `expected a terminal complete in ${JSON.stringify(kinds)}`);
  assert.equal(writer.getClearedCount(), 1);
});

test('queryClaudeSDK: resuming an existing session never re-announces session_created', async () => {
  queryImpl = async function* () {
    yield { type: 'assistant', session_id: 'existing-sess', message: { role: 'assistant', content: [{ type: 'text', text: 'again' }] } };
    yield { type: 'result', subtype: 'success', session_id: 'existing-sess', result: 'again' };
  };

  const writer = makeWriter();
  await queryClaudeSDK('continue', { sessionId: 'existing-sess' }, writer);

  const kinds = writer.sent.map((m: any) => m.kind);
  assert.ok(!kinds.includes('session_created'), `did not expect session_created in ${JSON.stringify(kinds)}`);
  assert.equal(capturedQueryArgs.options.resume, 'existing-sess');
});

test('queryClaudeSDK: canUseTool auto-allows a tool matching allowedTools without prompting', async () => {
  let observedDecision: any = null;
  queryImpl = async function* () {
    observedDecision = await capturedQueryArgs.options.canUseTool('Read', { file: 'a.ts' }, {});
    yield { type: 'result', subtype: 'success', session_id: 'sess-allow', result: 'ok' };
  };

  const writer = makeWriter();
  await queryClaudeSDK('read a file', { sessionId: 'sess-allow', toolsSettings: { allowedTools: ['Read'] } }, writer);

  assert.deepEqual(observedDecision, { behavior: 'allow', updatedInput: { file: 'a.ts' } });
  // Auto-allow never asks the user, so no permission_request frame goes out.
  assert.ok(!writer.sent.some((m: any) => m.kind === 'permission_request'));
});

test('queryClaudeSDK: canUseTool denies a tool matching disallowedTools without prompting', async () => {
  let observedDecision: any = null;
  queryImpl = async function* () {
    observedDecision = await capturedQueryArgs.options.canUseTool('Bash', { command: 'rm -rf /' }, {});
    yield { type: 'result', subtype: 'success', session_id: 'sess-deny', result: 'ok' };
  };

  const writer = makeWriter();
  await queryClaudeSDK('run a command', { sessionId: 'sess-deny', toolsSettings: { disallowedTools: ['Bash'] } }, writer);

  assert.equal(observedDecision.behavior, 'deny');
});

test('queryClaudeSDK: bypassPermissions auto-allows a non-interactive tool without prompting', async () => {
  let observedDecision: any = null;
  queryImpl = async function* () {
    observedDecision = await capturedQueryArgs.options.canUseTool('Write', { file: 'a.ts' }, {});
    yield { type: 'result', subtype: 'success', session_id: 'sess-bypass', result: 'ok' };
  };

  const writer = makeWriter();
  await queryClaudeSDK('write', { sessionId: 'sess-bypass', toolsSettings: { skipPermissions: true } }, writer);

  assert.deepEqual(observedDecision, { behavior: 'allow', updatedInput: { file: 'a.ts' } });
  assert.ok(!writer.sent.some((m: any) => m.kind === 'permission_request'));
});

test('queryClaudeSDK: an interaction-required tool still prompts even under bypassPermissions (documented caveat)', async () => {
  // Per the source comment on canUseTool: in real usage the SDK resolves
  // AskUserQuestion/ExitPlanMode at its own permission-mode step and never
  // calls this callback for them in bypass/auto modes. If it ever DID call
  // through (as this test forces, to exercise the branch), our own
  // `requiresInteraction` check still routes it through the full approval
  // wait rather than auto-allowing — so it must be resolved externally via
  // resolveToolApproval() or it hangs forever, exactly like the interactive
  // path for the 'default' permission mode.
  let observedDecision: any = null;
  queryImpl = async function* () {
    const decisionPromise = capturedQueryArgs.options.canUseTool('ExitPlanMode', {}, {});
    await new Promise((resolve) => setImmediate(resolve));
    observedDecision = await decisionPromise;
    yield { type: 'result', subtype: 'success', session_id: 'sess-bypass-interactive', result: 'ok' };
  };

  const writer = makeWriter();
  const runPromise = queryClaudeSDK('plan', { sessionId: 'sess-bypass-interactive', toolsSettings: { skipPermissions: true } }, writer);

  const { resolveToolApproval } = await import('./claude-sdk-runner.js');
  const deadline = Date.now() + 2000;
  let requestFrame: any = null;
  while (Date.now() < deadline && !requestFrame) {
    requestFrame = writer.sent.find((m: any) => m.kind === 'permission_request');
    if (!requestFrame) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(requestFrame, 'expected the interactive tool to still send a permission_request even in bypass mode');
  resolveToolApproval(requestFrame.requestId, { allow: true });

  await runPromise;
  assert.deepEqual(observedDecision, { behavior: 'allow', updatedInput: {} });
});

test('queryClaudeSDK: canUseTool sends a permission_request and honors the resolved decision', async () => {
  let observedDecision: any = null;
  let requestId: string | null = null;
  queryImpl = async function* () {
    const decisionPromise = capturedQueryArgs.options.canUseTool('Write', { file: 'x.ts' }, {});
    // The request lands on the writer synchronously (before the promise resolves).
    await new Promise((resolve) => setImmediate(resolve));
    observedDecision = await decisionPromise;
    yield { type: 'result', subtype: 'success', session_id: 'sess-prompt', result: 'ok' };
  };

  const writer = makeWriter();
  const runPromise = queryClaudeSDK('write a file', { sessionId: 'sess-prompt' }, writer);

  // Poll for the permission_request frame, then resolve it via the exported resolver.
  const { resolveToolApproval } = await import('./claude-sdk-runner.js');
  const deadline = Date.now() + 2000;
  let requestFrame: any = null;
  while (Date.now() < deadline && !requestFrame) {
    requestFrame = writer.sent.find((m: any) => m.kind === 'permission_request');
    if (!requestFrame) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(requestFrame, 'expected a permission_request frame');
  requestId = requestFrame.requestId;
  resolveToolApproval(requestId as string, { allow: true, updatedInput: { file: 'x.ts', extra: true } });

  await runPromise;
  assert.deepEqual(observedDecision, { behavior: 'allow', updatedInput: { file: 'x.ts', extra: true } });
  assert.ok(writer.getBlockedCalls().includes(true) && writer.getBlockedCalls().includes(false));
});

test('queryClaudeSDK: a denied tool approval maps to the deny result with the user message', async () => {
  let observedDecision: any = null;
  queryImpl = async function* () {
    const decisionPromise = capturedQueryArgs.options.canUseTool('Write', { file: 'x.ts' }, {});
    await new Promise((resolve) => setImmediate(resolve));
    observedDecision = await decisionPromise;
    yield { type: 'result', subtype: 'success', session_id: 'sess-deny-prompt', result: 'ok' };
  };

  const writer = makeWriter();
  const runPromise = queryClaudeSDK('write a file', { sessionId: 'sess-deny-prompt' }, writer);

  const { resolveToolApproval } = await import('./claude-sdk-runner.js');
  const deadline = Date.now() + 2000;
  let requestFrame: any = null;
  while (Date.now() < deadline && !requestFrame) {
    requestFrame = writer.sent.find((m: any) => m.kind === 'permission_request');
    if (!requestFrame) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(requestFrame);
  resolveToolApproval(requestFrame.requestId, { allow: false, message: 'no thanks' });

  await runPromise;
  assert.deepEqual(observedDecision, { behavior: 'deny', message: 'no thanks' });
});

test('queryClaudeSDK: the runtime abort handler interrupts the live query and is cleared afterward', async () => {
  let interruptCalls = 0;
  queryImpl = async function* () {
    const handler = null; // handler is installed via registerClaudeQueryAbort inside queryClaudeSDK
    yield { type: 'result', subtype: 'success', session_id: 'sess-abort-wire', result: 'ok' };
  };
  // Wrap the async generator object so it also exposes `interrupt()`, mirroring
  // the SDK's real Query type (an AsyncIterable with an interrupt() method).
  const originalImpl = queryImpl;
  queryImpl = (args: any) => {
    const generator = originalImpl(args);
    (generator as any).interrupt = async () => { interruptCalls += 1; };
    return generator;
  };

  const writer = makeWriter();
  await queryClaudeSDK('hi', { sessionId: 'sess-abort-wire' }, writer);

  const handler = writer.getAbortHandler();
  assert.equal(typeof handler, 'function');
  const result = await handler!();
  assert.equal(result, true);
  assert.equal(interruptCalls, 1);
});

test('queryClaudeSDK: retries once on a spawn-race error before any output, then succeeds', async () => {
  let attempts = 0;
  queryImpl = async function* () {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', syscall: 'spawn claude' });
    }
    yield { type: 'result', subtype: 'success', session_id: 'sess-retry', result: 'ok' };
  };

  const writer = makeWriter();
  const start = Date.now();
  await queryClaudeSDK('hi', { sessionId: 'sess-retry' }, writer);
  assert.equal(attempts, 2);
  assert.ok(writer.sent.some((m: any) => m.kind === 'complete'));
});

test('queryClaudeSDK: a non-spawn-race error is surfaced as an error frame and a failing complete', async () => {
  queryImpl = async function* () {
    throw new Error('boom');
    yield {};
  };

  const writer = makeWriter();
  await queryClaudeSDK('hi', { sessionId: 'sess-error' }, writer);

  const errorFrame = writer.sent.find((m: any) => m.kind === 'error');
  assert.ok(errorFrame, 'expected an error frame');
  const completeFrame = writer.sent.find((m: any) => m.kind === 'complete');
  assert.equal(completeFrame?.exitCode, 1);
});

test('queryClaudeSDK: an aborted run never sends a second terminal complete', async () => {
  const { abortClaudeSDKSession } = await import('./claude-sdk-runner.js');
  let releaseGenerator: (() => void) | null = null;
  const blocked = new Promise<void>((resolve) => { releaseGenerator = resolve; });

  queryImpl = () => {
    const generator = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-to-abort' };
      await blocked;
      throw new Error('interrupted');
    })();
    (generator as any).interrupt = async () => {
      releaseGenerator?.();
    };
    return generator;
  };

  const writer = makeWriter();
  const runPromise = queryClaudeSDK('hi', { sessionId: 'sess-to-abort' }, writer);

  // Wait for the session to register itself as active before aborting it.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const aborted = await abortClaudeSDKSession('sess-to-abort');
    if (aborted) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  await runPromise;
  const completeFrames = writer.sent.filter((m: any) => m.kind === 'complete');
  assert.equal(completeFrames.length, 0, 'the run loop must not emit its own complete for an aborted session');
});
