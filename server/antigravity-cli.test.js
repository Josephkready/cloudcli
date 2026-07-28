import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  abortAntigravitySession,
  resolveAntigravityPermissionArgs,
  spawnAntigravity,
} from './antigravity-cli.js';

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function createFakeAgy(binDir) {
  const scriptPath = path.join(binDir, 'agy.js');
  await writeFile(scriptPath, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'models') { console.log('gemini-test-model'); process.exit(0); }
if (process.env.AGY_ARGS_CAPTURE) {
  fs.writeFileSync(process.env.AGY_ARGS_CAPTURE, JSON.stringify({ args, cwd: process.cwd() }));
}
const id = process.env.AGY_FAKE_CONVERSATION_ID || 'agy-native-session';
console.log(JSON.stringify({ event: 'init', conversation_id: id, init: { model: 'gemini-test-model' } }));
if (process.env.AGY_FAKE_MODE === 'hang') {
  setInterval(() => {}, 1000);
} else if (process.env.AGY_FAKE_MODE === 'result-only') {
  console.log(JSON.stringify({ event: 'result', result: {
    conversation_id: id, status: 'SUCCESS', response: 'Only response'
  }}));
} else if (process.env.AGY_FAKE_MODE === 'error-result') {
  console.log(JSON.stringify({ event: 'result', result: {
    conversation_id: id, status: 'ERROR',
    error: 'Agy request failed Authorization: Bearer top-secret'
  }}));
} else if (process.env.AGY_FAKE_MODE === 'stderr-error') {
  console.error('Agy stderr failure');
  process.exitCode = 1;
} else {
  setTimeout(() => {
    console.log(JSON.stringify({ event: 'step_update', step_update: {
      conversation_id: id, step_type: 'agent_response', text_delta: 'Hello '
    }}));
  }, 10);
  setTimeout(() => {
    console.log(JSON.stringify({ event: 'step_update', step_update: {
      conversation_id: id, step_type: 'agent_response', text_delta: 'world'
    }}));
    console.log(JSON.stringify({ event: 'result', result: {
      conversation_id: id, status: 'SUCCESS', response: 'Hello world'
    }}));
  }, 20);
}
`, 'utf8');

  const commandPath = path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  if (process.platform === 'win32') {
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0agy.js" %*\r\n', 'utf8');
  } else {
    await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/agy.js" "$@"\n', 'utf8');
    await chmod(commandPath, 0o755);
  }
  return commandPath;
}

async function withFakeAgy(run) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-runtime-'));
  const binDir = path.join(tempRoot, 'bin');
  const pathKey = findEnvKey('PATH');
  const previousPath = process.env[pathKey];
  const previousPrefix = process.env.npm_config_prefix;
  const previousCapture = process.env.AGY_ARGS_CAPTURE;
  const previousConversation = process.env.AGY_FAKE_CONVERSATION_ID;
  const previousMode = process.env.AGY_FAKE_MODE;
  const previousExecutable = process.env.ANTIGRAVITY_CLI_PATH;

  try {
    await mkdir(binDir);
    process.env.ANTIGRAVITY_CLI_PATH = await createFakeAgy(binDir);
    process.env[pathKey] = `${binDir}${path.delimiter}${previousPath || ''}`;
    process.env.npm_config_prefix = tempRoot;
    await run(tempRoot);
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousPrefix === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = previousPrefix;
    if (previousCapture === undefined) delete process.env.AGY_ARGS_CAPTURE;
    else process.env.AGY_ARGS_CAPTURE = previousCapture;
    if (previousConversation === undefined) delete process.env.AGY_FAKE_CONVERSATION_ID;
    else process.env.AGY_FAKE_CONVERSATION_ID = previousConversation;
    if (previousMode === undefined) delete process.env.AGY_FAKE_MODE;
    else process.env.AGY_FAKE_MODE = previousMode;
    if (previousExecutable === undefined) delete process.env.ANTIGRAVITY_CLI_PATH;
    else process.env.ANTIGRAVITY_CLI_PATH = previousExecutable;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function createWriter() {
  const messages = [];
  return {
    messages,
    sessionId: null,
    userId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };
}

test('permission modes map onto agy flags', () => {
  assert.deepEqual(resolveAntigravityPermissionArgs('plan'), ['--mode', 'plan']);
  assert.deepEqual(resolveAntigravityPermissionArgs('acceptEdits'), ['--mode', 'accept-edits']);
  assert.deepEqual(resolveAntigravityPermissionArgs('bypassPermissions'), ['--dangerously-skip-permissions']);
  assert.deepEqual(resolveAntigravityPermissionArgs('default'), []);
});

test('spawnAntigravity streams NDJSON deltas and captures the native conversation id', { concurrency: false }, async () => {
  await withFakeAgy(async (tempRoot) => {
    const capturePath = path.join(tempRoot, 'args.json');
    process.env.AGY_ARGS_CAPTURE = capturePath;
    process.env.AGY_FAKE_CONVERSATION_ID = 'agy-native-new';
    const writer = createWriter();

    await spawnAntigravity('Hi there', {
      cwd: tempRoot,
      model: 'gemini-test-model',
      effort: 'high',
      permissionMode: 'acceptEdits',
    }, writer);

    assert.equal(writer.sessionId, 'agy-native-new');
    assert.deepEqual(
      writer.messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content),
      ['Hello ', 'world'],
    );
    assert.equal(writer.messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(writer.messages.find((message) => message.kind === 'complete')?.success, true);

    const capture = JSON.parse(await readFile(capturePath, 'utf8'));
    assert.equal(capture.args.includes('--conversation'), false);
    assert.equal(capture.args.includes('--effort'), false);
    const modelIndex = capture.args.indexOf('--model');
    assert.equal(capture.args[modelIndex + 1], 'gemini-test-model');
    assert.ok(capture.args.indexOf('--output-format') < capture.args.indexOf('--print'));
    assert.deepEqual(capture.args.slice(-2), ['--print', 'Hi there']);
  });
});

test('spawnAntigravity resumes with --conversation and does not announce a new session', { concurrency: false }, async () => {
  await withFakeAgy(async (tempRoot) => {
    const capturePath = path.join(tempRoot, 'args.json');
    process.env.AGY_ARGS_CAPTURE = capturePath;
    process.env.AGY_FAKE_CONVERSATION_ID = 'agy-existing';
    const writer = createWriter();

    await spawnAntigravity('Continue', {
      cwd: tempRoot,
      sessionId: 'agy-existing',
      model: 'gemini-test-model',
    }, writer);

    const capture = JSON.parse(await readFile(capturePath, 'utf8'));
    const conversationIndex = capture.args.indexOf('--conversation');
    const modelIndex = capture.args.indexOf('--model');
    assert.equal(capture.args[conversationIndex + 1], 'agy-existing');
    assert.equal(capture.args[modelIndex + 1], 'gemini-test-model');
    assert.equal(writer.messages.some((message) => message.kind === 'session_created'), false);
  });
});

test('spawnAntigravity emits a response-only result exactly once', { concurrency: false }, async () => {
  await withFakeAgy(async (tempRoot) => {
    process.env.AGY_FAKE_MODE = 'result-only';
    const writer = createWriter();

    await spawnAntigravity('Respond once', {
      cwd: tempRoot,
      model: 'gemini-test-model',
    }, writer);

    assert.deepEqual(
      writer.messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content),
      ['Only response'],
    );
    assert.equal(writer.messages.filter((message) => message.kind === 'complete').length, 1);
  });
});

test('spawnAntigravity reports a failed result once and rejects', { concurrency: false }, async () => {
  await withFakeAgy(async (tempRoot) => {
    process.env.AGY_FAKE_MODE = 'error-result';
    const writer = createWriter();

    await assert.rejects(
      spawnAntigravity('Fail', { cwd: tempRoot, model: 'gemini-test-model' }, writer),
      /Agy request failed/,
    );

    assert.deepEqual(
      writer.messages.filter((message) => message.kind === 'error').map((message) => message.content),
      ['Agy request failed Authorization: Bearer [REDACTED]'],
    );
    const completions = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].success, false);
  });
});

test('spawnAntigravity reports stderr from a nonzero exit once', { concurrency: false }, async () => {
  await withFakeAgy(async (tempRoot) => {
    process.env.AGY_FAKE_MODE = 'stderr-error';
    const writer = createWriter();

    await assert.rejects(
      spawnAntigravity('Fail', { cwd: tempRoot, model: 'gemini-test-model' }, writer),
      /Agy stderr failure/,
    );

    assert.equal(writer.messages.filter((message) => message.kind === 'error').length, 1);
    assert.equal(writer.messages.filter((message) => message.kind === 'complete').length, 1);
  });
});

test('spawnAntigravity handles a missing executable with one terminal failure', { concurrency: false }, async () => {
  await withFakeAgy(async (tempRoot) => {
    process.env.ANTIGRAVITY_CLI_PATH = path.join(tempRoot, 'missing-agy');
    const writer = createWriter();

    await assert.rejects(
      spawnAntigravity('Fail', { cwd: tempRoot, model: 'gemini-test-model' }, writer),
      /ENOENT/,
    );

    assert.equal(writer.messages.filter((message) => message.kind === 'error').length, 1);
    const completions = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].success, false);
  });
});

test('abortAntigravitySession terminates a live process with one aborted completion', { concurrency: false }, async () => {
  await withFakeAgy(async (tempRoot) => {
    process.env.AGY_FAKE_MODE = 'hang';
    process.env.AGY_FAKE_CONVERSATION_ID = 'agy-abort-me';
    const writer = createWriter();
    const run = spawnAntigravity('Wait', {
      cwd: tempRoot,
      model: 'gemini-test-model',
    }, writer);

    for (let attempt = 0; attempt < 50 && writer.sessionId !== 'agy-abort-me'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(writer.sessionId, 'agy-abort-me');
    assert.equal(abortAntigravitySession('agy-abort-me'), true);
    await run;

    const completions = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].aborted, true);
  });
});
