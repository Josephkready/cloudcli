import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChatMessage } from '../types/types';

import { getIntrinsicMessageKey } from './messageKeys';

// getIntrinsicMessageKey derives the React list key for a chat message. It
// prefers the first stable identifier present, then falls back to a
// timestamp+content composite, and returns null only when nothing usable
// exists. These pin the precedence order and the edge cases.

const m = (o: Record<string, unknown>): ChatMessage =>
  ({ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', ...o } as unknown as ChatMessage);

test('uses the first identifier field present, embedding the message type', () => {
  assert.equal(getIntrinsicMessageKey(m({ type: 'user', id: 'abc' })), 'message-user-abc');
  assert.equal(getIntrinsicMessageKey(m({ toolId: 't1' })), 'message-assistant-t1');
});

test('honors candidate precedence: id beats messageId beats toolId', () => {
  assert.equal(
    getIntrinsicMessageKey(m({ type: 'user', id: 'i1', messageId: 'm1', toolId: 't1' })),
    'message-user-i1',
  );
});

test('skips blank / whitespace-only identifiers and falls to the next candidate', () => {
  assert.equal(
    getIntrinsicMessageKey(m({ type: 'user', id: '   ', messageId: 'm1' })),
    'message-user-m1',
  );
});

test('accepts numeric identifiers, including 0', () => {
  assert.equal(getIntrinsicMessageKey(m({ type: 'tool', rowid: 42 })), 'message-tool-42');
  // 0 is falsy but a valid key part ("0"): it must not be skipped.
  assert.equal(getIntrinsicMessageKey(m({ type: 'tool', sequence: 0 })), 'message-tool-0');
});

test('ignores non-string/number identifier values (object) and uses the fallback', () => {
  const key = getIntrinsicMessageKey(
    m({ id: { nested: true }, content: 'hi', toolName: 'Bash' }),
  );
  // No usable identifier -> timestamp+content composite fallback.
  assert.equal(key, 'message-assistant-1767225600000-Bash-hi');
});

test('fallback composes type-timestamp-toolName-contentPreview (48-char content)', () => {
  const long = 'x'.repeat(60);
  const key = getIntrinsicMessageKey(m({ content: long, toolName: '' }));
  assert.equal(key, `message-assistant-1767225600000--${'x'.repeat(48)}`);
});

test('returns null when there is no identifier and the timestamp is invalid', () => {
  assert.equal(getIntrinsicMessageKey(m({ timestamp: 'not-a-date' })), null);
});
