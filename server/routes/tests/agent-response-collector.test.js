import assert from 'node:assert/strict';
import test from 'node:test';

import { ResponseCollector } from '../response-collector.js';

// Mirrors the normalized envelope every provider now streams
// (createNormalizedMessage). Only the fields the collector inspects matter.
const textMsg = (role, content, provider = 'claude') => ({
  id: `msg_${role}_${content}`,
  sessionId: 'sess-1',
  timestamp: '2026-07-18T00:00:00.000Z',
  provider,
  kind: 'text',
  role,
  content,
});

const tokenBudgetMsg = (tokenBudget, provider = 'claude') => ({
  id: `budget_${tokenBudget.outputTokens}`,
  sessionId: 'sess-1',
  timestamp: '2026-07-18T00:00:00.000Z',
  provider,
  kind: 'status',
  text: 'token_budget',
  tokenBudget,
});

test('getAssistantMessages returns assistant text and ignores everything else', () => {
  const c = new ResponseCollector();
  c.send({ kind: 'session_created', newSessionId: 'sess-1', provider: 'claude' });
  c.send(textMsg('user', 'the prompt')); // user echo — excluded
  c.send({ kind: 'thinking', content: 'hmm', provider: 'claude' }); // excluded
  c.send(textMsg('assistant', 'Hello there'));
  c.send({ kind: 'tool_use', toolName: 'Bash', toolId: 't1', provider: 'claude' }); // excluded
  c.send(textMsg('assistant', 'All done'));
  c.send(tokenBudgetMsg({ inputTokens: 10, outputTokens: 5 })); // excluded
  c.send({ kind: 'complete', success: true, exitCode: 0, provider: 'claude' }); // excluded

  const msgs = c.getAssistantMessages();
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs.map((m) => m.content), ['Hello there', 'All done']);
  assert.ok(msgs.every((m) => m.kind === 'text' && m.role === 'assistant'));
});

test('getAssistantMessages returns [] when the run produced no assistant text', () => {
  const c = new ResponseCollector();
  c.send({ kind: 'status', text: 'thinking', provider: 'claude' });
  c.send(textMsg('user', 'the prompt'));
  assert.deepEqual(c.getAssistantMessages(), []);
});

test('getAssistantMessages tolerates non-object frames without throwing', () => {
  const c = new ResponseCollector();
  c.send(null);
  c.send('legacy string frame');
  c.send(undefined);
  c.send(textMsg('assistant', 'survived'));
  assert.deepEqual(c.getAssistantMessages().map((m) => m.content), ['survived']);
});

test('getTotalTokens reads the last (cumulative) token_budget frame, not the sum', () => {
  const c = new ResponseCollector();
  c.send(textMsg('assistant', 'step 1'));
  // Claude reports a growing per-turn context; summing these would multiply-count.
  c.send(tokenBudgetMsg({
    inputTokens: 1200,
    outputTokens: 40,
    cacheReadTokens: 1000,
    cacheCreationTokens: 100,
  }));
  c.send(textMsg('assistant', 'step 2'));
  c.send(tokenBudgetMsg({
    inputTokens: 1800,
    outputTokens: 90,
    cacheReadTokens: 1500,
    cacheCreationTokens: 100,
  }));

  assert.deepEqual(c.getTotalTokens(), {
    inputTokens: 1800,
    outputTokens: 90,
    cacheReadTokens: 1500,
    cacheCreationTokens: 100,
    totalTokens: 1890, // inputTokens + outputTokens
  });
});

test('getTotalTokens handles a provider snapshot without cache fields (Codex-style)', () => {
  const c = new ResponseCollector();
  c.send(tokenBudgetMsg({ inputTokens: 500, outputTokens: 120 }, 'codex'));

  assert.deepEqual(c.getTotalTokens(), {
    inputTokens: 500,
    outputTokens: 120,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 620,
  });
});

test('getTotalTokens returns all-zero when no usage frame was emitted', () => {
  const c = new ResponseCollector();
  c.send(textMsg('assistant', 'no usage reported'));
  assert.deepEqual(c.getTotalTokens(), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  });
});

// The Codex runtime routes frames through a `sendMessage()` helper that
// JSON-encodes them for any transport it doesn't flag as an object-accepting
// writer (openai-codex.js) — and this collector is not flagged — so Codex frames
// reach `send()` as strings. Both read methods must still see them, else #96
// stays broken for Codex specifically.
test('reads assistant text and tokens from JSON-string frames (Codex transport)', () => {
  const c = new ResponseCollector();
  c.send(JSON.stringify(textMsg('user', 'prompt', 'codex')));
  c.send(JSON.stringify(textMsg('assistant', 'Codex reply', 'codex')));
  c.send(JSON.stringify(tokenBudgetMsg({ inputTokens: 500, outputTokens: 120 }, 'codex')));

  assert.deepEqual(c.getAssistantMessages().map((m) => m.content), ['Codex reply']);
  assert.deepEqual(c.getTotalTokens(), {
    inputTokens: 500,
    outputTokens: 120,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 620,
  });
});

test('getTotalTokens tolerates non-object / non-JSON frames without throwing', () => {
  const c = new ResponseCollector();
  c.send(null);
  c.send('not json at all');
  c.send(undefined);
  c.send(tokenBudgetMsg({ inputTokens: 7, outputTokens: 3 }));
  assert.equal(c.getTotalTokens().totalTokens, 10);
});

test('send() captures sessionId from both object and string frames', () => {
  const objColl = new ResponseCollector();
  objColl.send({ kind: 'session_created', sessionId: 'obj-sess', newSessionId: 'obj-sess' });
  assert.equal(objColl.getSessionId(), 'obj-sess');

  const strColl = new ResponseCollector();
  strColl.send(JSON.stringify({ kind: 'session_created', sessionId: 'str-sess' }));
  assert.equal(strColl.getSessionId(), 'str-sess');
});
