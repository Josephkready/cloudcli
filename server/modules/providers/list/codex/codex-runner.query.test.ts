import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';

// Drives queryCodex, the biggest uncovered chunk of server/modules/providers/list/codex/codex-runner.ts.
// Like the Claude runner, @openai/codex-sdk's `Codex` class shells out to a
// real `codex` CLI subprocess (dist/index.js: `new CodexExec(codexPathOverride, ...)`
// spawns `codex exec --experimental-json`), so rather than reimplementing that
// wire protocol this test intercepts the SDK's exported `Codex` class directly
// with node:test's `mock.module` (see claude-sdk-runner.query.test.ts for the
// same technique and why a plain property patch can't work on a real ESM
// named export). Needs `--experimental-test-module-mocks`, already added to
// package.json's test:server scripts.

type FakeThread = {
  id: string | null;
  runStreamed: (input: unknown, opts: { signal: AbortSignal }) => Promise<{ events: AsyncGenerator<any> }>;
};

let capturedThreadOptions: any = null;
let capturedResumeId: string | null = null;
let eventsImpl: () => AsyncGenerator<any> = async function* () {};
let threadIdValue: string | null = null;

class FakeCodex {
  startThread(options: any): FakeThread {
    capturedThreadOptions = options;
    capturedResumeId = null;
    return this.makeThread();
  }

  resumeThread(id: string, options: any): FakeThread {
    capturedThreadOptions = options;
    capturedResumeId = id;
    return this.makeThread();
  }

  private makeThread(): FakeThread {
    return {
      id: threadIdValue,
      runStreamed: async (_input: unknown, _opts: { signal: AbortSignal }) => ({
        events: eventsImpl(),
      }),
    };
  }
}

mock.module('@openai/codex-sdk', {
  namedExports: {
    Codex: FakeCodex,
  },
});

const { queryCodex, abortCodexSession } = await import('./codex-runner.js');
const { providerModelsService } = await import('@/modules/providers/services/provider-models.service.js');
const { closeConnection, initializeDatabase, userDb } = await import('@/modules/database/index.js');

const tempDirectory = await mkdtemp(path.join('/var/tmp', 'codex-runner-'));
process.env.HOME = tempDirectory;
process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
process.env.VITE_AUTH_DISABLED = 'true';
closeConnection();
await initializeDatabase();
const seededUser = userDb.getFirstUser();
if (!seededUser) {
  throw new Error('expected initializeDatabase() to seed a default user in auth-disabled mode');
}
const TEST_USER_ID = seededUser.id;

test.after(async () => {
  closeConnection();
  await rm(tempDirectory, { recursive: true, force: true });
});

// Stub the model catalog so queryCodex never touches ~/.codex/config.toml or
// any network path — same technique as antigravity-runner.test.ts's
// withStubbedAntigravityCatalog.
const originalGetModels = providerModelsService.getProviderModels;
const originalResolveResumeModel = providerModelsService.resolveResumeModel;
providerModelsService.getProviderModels = async () => ({
  models: {
    DEFAULT: 'gpt-5.4',
    OPTIONS: [{ value: 'gpt-5.4', label: 'gpt-5.4', effort: { values: [{ value: 'high', label: 'High' }] } }],
  } as any,
  cache: { updatedAt: new Date(0).toISOString(), expiresAt: new Date(0).toISOString(), source: 'memory' },
});
providerModelsService.resolveResumeModel = async (_provider, _sessionId, requested) => requested ?? undefined;
test.after(() => {
  providerModelsService.getProviderModels = originalGetModels;
  providerModelsService.resolveResumeModel = originalResolveResumeModel;
});

function makeWriter() {
  const sent: any[] = [];
  let abortHandler: (() => boolean) | null = null;
  let cleared = 0;
  return {
    userId: TEST_USER_ID,
    sent,
    send: (message: any) => sent.push(message),
    setSessionId: () => {},
    setAbortHandler: (handler: () => boolean) => { abortHandler = handler; },
    clearAbortHandler: () => { cleared += 1; },
    isRunActive: () => true,
    getAbortHandler: () => abortHandler,
    getClearedCount: () => cleared,
  } as any;
}

test('queryCodex: a new session streams an agent message and sends session_created once', async () => {
  threadIdValue = null;
  eventsImpl = async function* () {
    yield { type: 'thread.started', thread_id: 'codex-sess-1' };
    yield { type: 'turn.started' };
    yield {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Hello from Codex' },
    };
    yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  };

  const writer = makeWriter();
  await queryCodex('hi', {}, writer);

  const kinds = writer.sent.map((m: any) => m.kind);
  assert.ok(kinds.includes('session_created'), `expected session_created in ${JSON.stringify(kinds)}`);
  assert.equal(writer.sent.filter((m: any) => m.kind === 'session_created').length, 1);
  assert.ok(kinds.includes('complete'), `expected complete in ${JSON.stringify(kinds)}`);
  assert.equal(writer.getClearedCount(), 1);
});

test('queryCodex: resuming an existing session passes the id to resumeThread and skips session_created', async () => {
  eventsImpl = async function* () {
    yield { type: 'item.completed', item: { type: 'agent_message', text: 'again' } };
    yield { type: 'turn.completed', usage: {} };
  };

  const writer = makeWriter();
  await queryCodex('continue', { sessionId: 'existing-codex-sess' }, writer);

  assert.equal(capturedResumeId, 'existing-codex-sess');
  const kinds = writer.sent.map((m: any) => m.kind);
  assert.ok(!kinds.includes('session_created'));
});

test('queryCodex: item.started/item.updated events are skipped entirely', async () => {
  eventsImpl = async function* () {
    yield { type: 'item.started', item: { type: 'agent_message', text: 'partial' } };
    yield { type: 'item.updated', item: { type: 'agent_message', text: 'partial2' } };
    yield { type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: 'a.txt', exit_code: 0, status: 'completed' } };
    yield { type: 'turn.completed', usage: {} };
  };

  const writer = makeWriter();
  await queryCodex('run ls', { sessionId: 'codex-sess-skip' }, writer);

  // Only the item.completed + terminal frames should have gone through, never
  // frames sourced from item.started/item.updated (they `continue` before
  // reaching transformCodexEvent/sendMessage).
  const toolUseFrames = writer.sent.filter((m: any) => m.kind === 'tool_use');
  assert.equal(toolUseFrames.length, 1);
});

test('queryCodex: a turn.failed event notifies but does not stop the stream, and marks exitCode 1', async () => {
  eventsImpl = async function* () {
    yield { type: 'turn.failed', error: { message: 'model overloaded' } };
    yield { type: 'turn.completed', usage: {} };
  };

  const writer = makeWriter();
  await queryCodex('do something', { sessionId: 'codex-sess-failed' }, writer);

  // normalizeMessage() itself also turns a 'turn_failed' raw event into an
  // error+complete pair for the session-history record (the second frame has
  // no exitCode — it's not the terminal transport-level complete). The
  // runner's own terminal complete is the one that always carries exitCode.
  const terminalComplete = writer.sent.find((m: any) => m.kind === 'complete' && typeof m.exitCode === 'number');
  assert.equal(terminalComplete?.exitCode, 1);
});

test('queryCodex: turn.completed usage is normalized into a token_budget status frame', async () => {
  eventsImpl = async function* () {
    yield {
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    };
  };

  const writer = makeWriter();
  await queryCodex('hi', { sessionId: 'codex-sess-tokens' }, writer);

  const statusFrame = writer.sent.find((m: any) => m.kind === 'status' && m.text === 'token_budget');
  assert.ok(statusFrame, 'expected a token_budget status frame');
  assert.equal(statusFrame.tokenBudget.inputTokens, 100);
  assert.equal(statusFrame.tokenBudget.outputTokens, 20);
  assert.equal(statusFrame.tokenBudget.used, 120);
});

test('queryCodex: the runtime abort handler aborts the controller and is cleared afterward', async () => {
  eventsImpl = async function* () {
    yield { type: 'turn.completed', usage: {} };
  };

  const writer = makeWriter();
  await queryCodex('hi', { sessionId: 'codex-sess-abort-wire' }, writer);

  const handler = writer.getAbortHandler();
  assert.equal(typeof handler, 'function');
  // Safe to call post-hoc: AbortController.abort() is idempotent.
  assert.equal(handler!(), true);
});

test('queryCodex: aborting mid-stream stops the event loop and skips the terminal complete', async () => {
  let releaseSecondEvent!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseSecondEvent = resolve; });

  eventsImpl = async function* () {
    yield { type: 'thread.started', thread_id: 'codex-sess-to-abort' };
    await blocked;
    yield { type: 'item.completed', item: { type: 'agent_message', text: 'should never be seen' } };
    yield { type: 'turn.completed', usage: {} };
  };

  const writer = makeWriter();
  const runPromise = queryCodex('hi', {}, writer);

  const deadline = Date.now() + 2000;
  let aborted = false;
  while (Date.now() < deadline && !aborted) {
    aborted = abortCodexSession('codex-sess-to-abort');
    if (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(aborted, 'expected abortCodexSession to find the session once thread.started fired');
  releaseSecondEvent();

  await runPromise;
  const kinds = writer.sent.map((m: any) => m.kind);
  assert.ok(!kinds.includes('complete'), `an aborted run must not emit its own terminal complete, got ${JSON.stringify(kinds)}`);
  assert.ok(!writer.sent.some((m: any) => m.content === 'should never be seen'));
});

test('queryCodex: a thrown error (not an abort) is surfaced as an error frame and a failing complete', async () => {
  eventsImpl = async function* () {
    throw new Error('codex exploded');
    yield {};
  };

  const writer = makeWriter();
  await queryCodex('hi', { sessionId: 'codex-sess-error' }, writer);

  const errorFrame = writer.sent.find((m: any) => m.kind === 'error');
  assert.ok(errorFrame, 'expected an error frame');
  const completeFrame = writer.sent.find((m: any) => m.kind === 'complete');
  assert.equal(completeFrame?.exitCode, 1);
});

test('queryCodex: an AbortError thrown by the SDK is treated as an aborted run, not a failure', async () => {
  eventsImpl = async function* () {
    throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    yield {};
  };

  const writer = makeWriter();
  await queryCodex('hi', { sessionId: 'codex-sess-abort-error' }, writer);

  assert.ok(!writer.sent.some((m: any) => m.kind === 'error'));
  assert.ok(!writer.sent.some((m: any) => m.kind === 'complete'));
});

test('queryCodex: permissionMode maps to the expected sandbox/approval Codex options', async () => {
  eventsImpl = async function* () {
    yield { type: 'turn.completed', usage: {} };
  };

  const writer = makeWriter();

  await queryCodex('hi', { sessionId: 'codex-sess-accept', permissionMode: 'acceptEdits' }, writer);
  assert.equal(capturedThreadOptions.sandboxMode, 'workspace-write');
  assert.equal(capturedThreadOptions.approvalPolicy, 'never');

  await queryCodex('hi', { sessionId: 'codex-sess-bypass', permissionMode: 'bypassPermissions' }, writer);
  assert.equal(capturedThreadOptions.sandboxMode, 'danger-full-access');
  assert.equal(capturedThreadOptions.approvalPolicy, 'never');

  await queryCodex('hi', { sessionId: 'codex-sess-default' }, writer);
  assert.equal(capturedThreadOptions.sandboxMode, 'workspace-write');
  assert.equal(capturedThreadOptions.approvalPolicy, 'untrusted');
});

test('queryCodex: an unsupported effort value for the resolved model is dropped', async () => {
  eventsImpl = async function* () {
    yield { type: 'turn.completed', usage: {} };
  };

  const writer = makeWriter();
  await queryCodex('hi', { sessionId: 'codex-sess-effort', model: 'gpt-5.4', effort: 'not-a-real-effort' }, writer);
  assert.equal(capturedThreadOptions.modelReasoningEffort, undefined);

  await queryCodex('hi', { sessionId: 'codex-sess-effort-2', model: 'gpt-5.4', effort: 'high' }, writer);
  assert.equal(capturedThreadOptions.modelReasoningEffort, 'high');
});

