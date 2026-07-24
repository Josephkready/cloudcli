import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyClaudeLiveStatus,
  resolveSessionLiveStatus,
} from './session-live-status.service.js';

const NOW = Date.parse('2026-07-19T12:00:00.000Z');
const SECONDS = 1_000;
const MINUTES = 60 * SECONDS;

// --- Transcript line builders (Claude on-disk JSONL shape) ---

function assistantToolUse(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] },
    timestamp: '2026-07-19T11:59:58.000Z',
  });
}

function userToolResult(toolUseId: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: false }] },
    timestamp: '2026-07-19T11:59:59.000Z',
  });
}

function assistantText(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: '2026-07-19T11:59:59.000Z',
  });
}

function assistantNamedToolUse(id: string, name: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    timestamp: '2026-07-19T11:59:58.000Z',
  });
}

// An assistant turn parked on an unanswered tool_use is the on-disk proxy for
// "awaiting the user" (permission / plan approval / a slow tool).
const AWAITING_TAIL = [assistantText('working on it'), assistantToolUse('tool-1')].join('\n');
// Same tool, then its result: the turn advanced, nothing is waiting on me.
const ACTIVE_TAIL = [assistantToolUse('tool-1'), userToolResult('tool-1')].join('\n');
// A plan submitted for approval: a deliberate, indefinite wait on the user.
const PLAN_TAIL = [assistantText('here is the plan'), assistantNamedToolUse('plan-1', 'ExitPlanMode')].join('\n');
// A direct question to the user: also a deliberate interaction wait.
const QUESTION_TAIL = [assistantText('quick question'), assistantNamedToolUse('q-1', 'AskUserQuestion')].join('\n');

test('recent transcript + pending tool_use (awaiting input) => blocked', () => {
  assert.equal(classifyClaudeLiveStatus(AWAITING_TAIL, NOW - 2 * SECONDS, NOW), 'blocked');
});

test('recent transcript + resolved/active last event => working', () => {
  assert.equal(classifyClaudeLiveStatus(ACTIVE_TAIL, NOW - 2 * SECONDS, NOW), 'working');
});

test('old transcript => idle regardless of last event', () => {
  assert.equal(classifyClaudeLiveStatus(AWAITING_TAIL, NOW - 30 * MINUTES, NOW), 'idle');
  assert.equal(classifyClaudeLiveStatus(ACTIVE_TAIL, NOW - 30 * MINUTES, NOW), 'idle');
});

test('a pending turn past the awaiting-input window (but stale) is idle, not blocked', () => {
  // 6 min old: beyond the 5-min awaiting-input window and the 15s working window.
  assert.equal(classifyClaudeLiveStatus(AWAITING_TAIL, NOW - 6 * MINUTES, NOW), 'idle');
});

test('an unanswered tool_use up to ~5 min old still ranks blocked (parked prompt)', () => {
  assert.equal(classifyClaudeLiveStatus(AWAITING_TAIL, NOW - 4 * MINUTES, NOW), 'blocked');
});

test('a plan awaiting approval ranks plan, not blocked/idle', () => {
  assert.equal(classifyClaudeLiveStatus(PLAN_TAIL, NOW - 2 * SECONDS, NOW), 'plan');
});

test('a plan stays plan long past the generic 5-min prompt window (interaction wait)', () => {
  // 30 min old: a generic prompt would have decayed to idle here, but a plan
  // submitted for approval is an indefinite wait on the user.
  assert.equal(classifyClaudeLiveStatus(PLAN_TAIL, NOW - 30 * MINUTES, NOW), 'plan');
  // Just inside the 4h interaction window vs. just past it.
  assert.equal(classifyClaudeLiveStatus(PLAN_TAIL, NOW - 4 * 60 * MINUTES, NOW), 'plan');
  assert.equal(classifyClaudeLiveStatus(PLAN_TAIL, NOW - (4 * 60 * MINUTES + 1), NOW), 'idle');
});

test('a pending AskUserQuestion ranks blocked and shares the long interaction window', () => {
  assert.equal(classifyClaudeLiveStatus(QUESTION_TAIL, NOW - 2 * SECONDS, NOW), 'blocked');
  // 30 min old: still blocked (interaction wait), unlike a generic prompt.
  assert.equal(classifyClaudeLiveStatus(QUESTION_TAIL, NOW - 30 * MINUTES, NOW), 'blocked');
  // Shares the 4h interaction boundary with plans: at the edge blocked, past it idle.
  assert.equal(classifyClaudeLiveStatus(QUESTION_TAIL, NOW - 4 * 60 * MINUTES, NOW), 'blocked');
  assert.equal(classifyClaudeLiveStatus(QUESTION_TAIL, NOW - (4 * 60 * MINUTES + 1), NOW), 'idle');
});

test('an interaction tool wins over a co-issued generic tool in the same turn', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'read-1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} },
      ],
    },
  });
  assert.equal(classifyClaudeLiveStatus(line, NOW - 30 * MINUTES, NOW), 'plan');
});

test('a resolved plan (has its tool_result) is not plan', () => {
  const tail = [assistantNamedToolUse('plan-1', 'ExitPlanMode'), userToolResult('plan-1')].join('\n');
  // Resolved and 20s old → past the working window, nothing pending → idle.
  assert.equal(classifyClaudeLiveStatus(tail, NOW - 20 * SECONDS, NOW), 'idle');
});

test('a resolved turn older than the working window is idle', () => {
  // 20s old: past the 15s working window, not awaiting input.
  assert.equal(classifyClaudeLiveStatus(ACTIVE_TAIL, NOW - 20 * SECONDS, NOW), 'idle');
});

test('window boundaries are inclusive (<=): exactly at the edge still counts', () => {
  // WORKING_WINDOW_MS = 15_000ms: at the edge is working, one ms past is idle.
  assert.equal(classifyClaudeLiveStatus(ACTIVE_TAIL, NOW - 15_000, NOW), 'working');
  assert.equal(classifyClaudeLiveStatus(ACTIVE_TAIL, NOW - 15_001, NOW), 'idle');
  // AWAITING_INPUT_WINDOW_MS = 300_000ms: at the edge is blocked, one ms past is idle.
  assert.equal(classifyClaudeLiveStatus(AWAITING_TAIL, NOW - 300_000, NOW), 'blocked');
  assert.equal(classifyClaudeLiveStatus(AWAITING_TAIL, NOW - 300_001, NOW), 'idle');
});

test('empty / whitespace tail with a fresh mtime is working (nothing pending)', () => {
  assert.equal(classifyClaudeLiveStatus('', NOW - 1 * SECONDS, NOW), 'working');
  assert.equal(classifyClaudeLiveStatus('  \n\n', NOW - 1 * SECONDS, NOW), 'working');
});

test('a truncated leading line is tolerated; the last complete record decides', () => {
  const tail = ['{"type":"assist', assistantToolUse('tool-9')].join('\n');
  assert.equal(classifyClaudeLiveStatus(tail, NOW - 2 * SECONDS, NOW), 'blocked');
});

test('multiple tool_use in the last turn: any unresolved one is blocked', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'Read', input: {} },
        { type: 'tool_use', id: 'b', name: 'Bash', input: {} },
      ],
    },
  });
  const tail = [line, userToolResult('a')].join('\n');
  assert.equal(classifyClaudeLiveStatus(tail, NOW - 2 * SECONDS, NOW), 'blocked');
});

async function withTempTranscript(
  contents: string,
  run: (jsonlPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-status-'));
  const jsonlPath = path.join(dir, 'session.jsonl');
  try {
    await writeFile(jsonlPath, contents, 'utf8');
    await run(jsonlPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('resolveSessionLiveStatus reads a fresh claude transcript and reports blocked', async () => {
  await withTempTranscript(AWAITING_TAIL, async (jsonlPath) => {
    const status = await resolveSessionLiveStatus({
      provider: 'claude',
      sessionId: 'sess-1',
      jsonlPath,
      projectPath: null,
    });
    assert.equal(status, 'blocked');
  });
});

test('resolveSessionLiveStatus reports working for a fresh, non-waiting transcript', async () => {
  await withTempTranscript(ACTIVE_TAIL, async (jsonlPath) => {
    const status = await resolveSessionLiveStatus({
      provider: 'claude',
      sessionId: 'sess-2',
      jsonlPath,
      projectPath: null,
    });
    assert.equal(status, 'working');
  });
});

test('resolveSessionLiveStatus grows the tail window for a large final tool_use (still blocked)', async () => {
  // A final Write tool_use whose JSON line far exceeds the initial 128KB read
  // window: the slice lands inside that one oversized line and parses nothing,
  // so the classifier must grow the window rather than miss the pending write.
  const bigInput = 'x'.repeat(300 * 1024);
  const hugeToolUse = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'big', name: 'Write', input: { content: bigInput } }] },
  });
  const contents = `${[assistantText('starting'), hugeToolUse].join('\n')}\n`;
  await withTempTranscript(contents, async (jsonlPath) => {
    const status = await resolveSessionLiveStatus({
      provider: 'claude',
      sessionId: 'big-sess',
      jsonlPath,
      projectPath: null,
    });
    assert.equal(status, 'blocked');
  });
});

test('resolveSessionLiveStatus reads a plan transcript older than the generic window (fast-path uses the interaction window)', async () => {
  await withTempTranscript(PLAN_TAIL, async (jsonlPath) => {
    // Backdate the file to 30 min ago: past the 5-min generic fast-path cutoff,
    // still inside the 4h interaction window — the tail must still be read.
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000);
    await utimes(jsonlPath, thirtyMinAgo, thirtyMinAgo);
    const status = await resolveSessionLiveStatus({
      provider: 'claude',
      sessionId: 'plan-sess',
      jsonlPath,
      projectPath: null,
    });
    assert.equal(status, 'plan');
  });
});

test('resolveSessionLiveStatus fast-paths a plan transcript older than the 4h interaction window to idle', async () => {
  await withTempTranscript(PLAN_TAIL, async (jsonlPath) => {
    // Backdate past the 4h interaction window: the disk fast-path must skip the
    // read and return idle (a plan parked this long is treated as abandoned).
    const pastWindow = new Date(Date.now() - (4 * 60 + 1) * 60_000);
    await utimes(jsonlPath, pastWindow, pastWindow);
    const status = await resolveSessionLiveStatus({
      provider: 'claude',
      sessionId: 'plan-stale',
      jsonlPath,
      projectPath: null,
    });
    assert.equal(status, 'idle');
  });
});

test('resolveSessionLiveStatus is idle for non-claude providers (no misparse risk)', async () => {
  await withTempTranscript(AWAITING_TAIL, async (jsonlPath) => {
    const status = await resolveSessionLiveStatus({
      provider: 'codex',
      sessionId: 'sess-3',
      jsonlPath,
      projectPath: null,
    });
    assert.equal(status, 'idle');
  });
});

test('resolveSessionLiveStatus is idle when the transcript cannot be located', async () => {
  const status = await resolveSessionLiveStatus({
    provider: 'claude',
    sessionId: 'missing',
    jsonlPath: '/nonexistent/path/session.jsonl',
    projectPath: null,
  });
  assert.equal(status, 'idle');
});
