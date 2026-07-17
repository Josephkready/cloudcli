import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTENTION_EVENT_KINDS,
  isAttentionEventKind,
} from './attentionEvents';

// The core of #44: kinds that fire while the agent is actively running (or that
// mark a run *starting*) must not promote a background session to "needs
// attention".
test('streaming, progress, and run-start kinds never mark attention', () => {
  for (const kind of [
    'stream_delta',
    'text',
    'thinking',
    'tool_use',
    'tool_result',
    'status',
    'stream_end',
    'session_upserted',
    'chat_subscribed',
    'permission_cancelled',
    'session_created', // run starting, not finishing/blocking
    'error', // non-terminal: providers emit it for mid-run stderr
    'task_notification', // unemitted today; inert on purpose (revisit if added)
  ]) {
    assert.equal(isAttentionEventKind(kind), false, `${kind} must not mark attention`);
  }
});

// Notification-channel-only kinds (web-push / desktop) are never websocket
// frames, so the sidebar handler never sees them — their sidebar-visible
// equivalents (`complete` / `permission_request`) carry the signal instead.
test('notification-only kinds are not treated as sidebar attention', () => {
  for (const kind of ['stop', 'action_required']) {
    assert.equal(isAttentionEventKind(kind), false, `${kind} is notification-only`);
  }
});

test('blocked and terminal websocket kinds mark attention', () => {
  for (const kind of ['complete', 'permission_request', 'interactive_prompt', 'protocol_error']) {
    assert.equal(isAttentionEventKind(kind), true, `${kind} should mark attention`);
    assert.ok(ATTENTION_EVENT_KINDS.has(kind));
  }
});

test('missing or non-string kinds are ignored', () => {
  assert.equal(isAttentionEventKind(null), false);
  assert.equal(isAttentionEventKind(undefined), false);
  assert.equal(isAttentionEventKind(''), false);
});

// A transcript write (`session_upserted`) is a passive "changed on disk" signal,
// not a "needs you" one — it must never promote a session to attention (#38).
test('session_upserted is not an attention event kind', () => {
  assert.equal(isAttentionEventKind('session_upserted'), false);
  assert.ok(!ATTENTION_EVENT_KINDS.has('session_upserted'));
});
