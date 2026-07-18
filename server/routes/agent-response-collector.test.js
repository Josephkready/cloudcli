import assert from 'node:assert/strict';
import test from 'node:test';

import { ResponseCollector } from './agent-response-collector.js';

// A normalized assistant text frame as emitted by every provider's
// normalizeMessage() (see claude-sessions.provider.ts / codex-sessions.provider.ts).
const assistantText = (content, provider = 'claude', extra = {}) => ({
  id: `msg_${content}`,
  kind: 'text',
  role: 'assistant',
  provider,
  sessionId: 'sess-1',
  timestamp: '2026-07-18T00:00:00.000Z',
  content,
  ...extra,
});

// A token_budget status frame as emitted by claude-sdk.js / openai-codex.js.
const tokenBudget = (budget, provider = 'claude') => ({
  kind: 'status',
  text: 'token_budget',
  provider,
  sessionId: 'sess-1',
  tokenBudget: budget,
});

test('getAssistantMessages returns assistant text turns with non-empty content', () => {
  const collector = new ResponseCollector();
  collector.send({ type: 'status', message: 'starting' }); // initial status shim
  collector.send({ kind: 'text', role: 'user', content: 'hello', provider: 'claude' });
  collector.send(assistantText('First reply'));
  collector.send({ kind: 'tool_use', toolName: 'Edit', provider: 'claude' });
  collector.send({ kind: 'thinking', content: 'hmm', provider: 'claude' });
  collector.send(assistantText('Second reply'));

  const messages = collector.getAssistantMessages();

  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((m) => m.content), ['First reply', 'Second reply']);
  assert.ok(messages.every((m) => m.role === 'assistant'));
  assert.equal(messages[0].provider, 'claude');
  assert.equal(messages[0].id, 'msg_First reply');
});

test('getAssistantMessages drops empty-content frames and falls back to `text`', () => {
  const collector = new ResponseCollector();
  collector.send(assistantText('')); // empty content -> dropped
  // A frame with no `content` but a `text` field falls back to it.
  collector.send(assistantText('', 'claude', { content: undefined, text: 'from text field' }));

  const messages = collector.getAssistantMessages();

  assert.deepEqual(messages.map((m) => m.content), ['from text field']);
});

test('getAssistantMessages handles JSON-string entries', () => {
  const collector = new ResponseCollector();
  collector.send(JSON.stringify(assistantText('Stringified reply')));
  collector.send('not json at all');

  const messages = collector.getAssistantMessages();

  assert.deepEqual(messages.map((m) => m.content), ['Stringified reply']);
});

test('getTotalTokens uses the LAST token_budget frame (cumulative, not summed)', () => {
  const collector = new ResponseCollector();
  // Two cumulative frames: the second supersedes the first. Summing would
  // double-count; the correct total is the final frame.
  collector.send(tokenBudget({
    used: 300,
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 40,
    cacheCreationTokens: 10,
  }));
  collector.send(assistantText('reply'));
  collector.send(tokenBudget({
    used: 900,
    inputTokens: 600,
    outputTokens: 300,
    cacheReadTokens: 120,
    cacheCreationTokens: 30,
  }));

  const tokens = collector.getTotalTokens();

  assert.deepEqual(tokens, {
    inputTokens: 600,
    outputTokens: 300,
    cacheReadTokens: 120,
    cacheCreationTokens: 30,
    totalTokens: 900,
  });
});

test('getTotalTokens derives totalTokens from input+output when `used` is absent', () => {
  const collector = new ResponseCollector();
  // Codex-style budget: no cache fields, no `used`.
  collector.send(tokenBudget({ inputTokens: 150, outputTokens: 50 }, 'codex'));

  const tokens = collector.getTotalTokens();

  assert.deepEqual(tokens, {
    inputTokens: 150,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 200,
  });
});

test('getTotalTokens returns all-zero when no token_budget frame was seen', () => {
  const collector = new ResponseCollector();
  collector.send(assistantText('reply with no usage'));

  assert.deepEqual(collector.getTotalTokens(), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  });
});

test('non-numeric token fields coerce to 0', () => {
  const collector = new ResponseCollector();
  collector.send(tokenBudget({ inputTokens: 'abc', outputTokens: null, used: undefined }));

  assert.deepEqual(collector.getTotalTokens(), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  });
});

test('sessionId is captured from message frames and via setSessionId', () => {
  const collector = new ResponseCollector();
  assert.equal(collector.getSessionId(), null);

  collector.send(assistantText('reply')); // carries sessionId: 'sess-1'
  assert.equal(collector.getSessionId(), 'sess-1');

  collector.setSessionId('override');
  assert.equal(collector.getSessionId(), 'override');
});
