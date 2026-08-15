import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClaudeSessionsProvider,
  isAgentAuthoredUserTurn,
  isInternalContent,
} from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * Regression suite for #335: agent/harness-authored turns rendering with the
 * user's blue styling.
 *
 * The fixtures below are verbatim shapes captured from a real Claude Agent SDK
 * stream and from real `~/.claude/projects/**.jsonl` transcripts, because the
 * whole bug was a mismatch between what the two transports actually emit:
 * persisted rows carry `isMeta`, live rows carry `isSynthetic` / `origin`.
 */

const provider = new ClaudeSessionsProvider();

function userTexts(raw: unknown): string[] {
  return provider
    .normalizeMessage(raw, 'session-1')
    .filter((message) => message.kind === 'text' && message.role === 'user')
    .map((message) => message.content ?? '');
}

function textPart(text: string) {
  return { type: 'text', text };
}

test('live stop-hook feedback is not attributed to the user', () => {
  // Captured verbatim from the SDK stream: note there is no `isMeta` field,
  // which is exactly why the persisted-transcript filter never fired here.
  const raw = {
    type: 'user',
    message: {
      role: 'user',
      content: [textPart('Stop hook feedback:\nPROBE-INJECTED: now reply with the single word beta.')],
    },
    parent_tool_use_id: null,
    session_id: 'session-1',
    uuid: 'u1',
    timestamp: '2026-08-15T02:49:10.812Z',
    isSynthetic: true,
  };

  assert.equal(isAgentAuthoredUserTurn(raw), true);
  assert.deepEqual(userTexts(raw), []);
});

test('a live tool_result turn still yields its tool result', () => {
  // Also captured verbatim: real tool results carry none of the provenance
  // fields, so the new filter must leave them completely alone.
  const raw = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello-probe', is_error: false },
      ],
    },
    parent_tool_use_id: null,
    session_id: 'session-1',
    uuid: 'u2',
    timestamp: '2026-08-15T02:49:10.812Z',
  };

  assert.equal(isAgentAuthoredUserTurn(raw), false);
  const normalized = provider.normalizeMessage(raw, 'session-1');
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].kind, 'tool_result');
  assert.equal(normalized[0].content, 'hello-probe');
});

test('a real keyboard message is still a user message', () => {
  // Guards the local-echo reconciliation added in #327/#336: if genuine user
  // turns stopped coming back, queued messages would never reconcile.
  const raw = {
    type: 'user',
    message: { role: 'user', content: [textPart('How about we keep it but fix the weight and reps')] },
    parent_tool_use_id: null,
    session_id: 'session-1',
    uuid: 'u3',
  };

  assert.equal(isAgentAuthoredUserTurn(raw), false);
  assert.deepEqual(userTexts(raw), ['How about we keep it but fix the weight and reps']);
});

test('an explicit human origin is still a user message', () => {
  const raw = {
    type: 'user',
    message: { role: 'user', content: 'I do not have that machine' },
    origin: { kind: 'human' },
    uuid: 'u4',
  };

  assert.equal(isAgentAuthoredUserTurn(raw), false);
  assert.deepEqual(userTexts(raw), ['I do not have that machine']);
});

test('non-human origins are not attributed to the user', () => {
  // `SDKMessageOrigin` kinds that relay someone/something other than the
  // person at the keyboard.
  for (const kind of ['peer', 'coordinator', 'channel', 'auto-continuation']) {
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: [textPart('Another Claude session sent a message while you were working: ship it')],
      },
      origin: { kind },
      uuid: `u-${kind}`,
    };

    assert.equal(isAgentAuthoredUserTurn(raw), true, `${kind} should not be user-authored`);
    assert.deepEqual(userTexts(raw), [], `${kind} should not render as a user bubble`);
  }
});

test('skill re-invocation banners are suppressed even though no prefix matches them', () => {
  // The prior fix (#41) only added the `Base directory for this skill:` prefix,
  // which matches the *first* invocation. These are the second-invocation
  // variants the transcripts actually contain, and no prefix covers them.
  const banners = [
    'Skill /make-pr is already loaded above; instructions unchanged.',
    '(Re-invocation of /start-work — the skill instructions were previously loaded; the arguments below are new.)',
    '[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]',
    'Continue from where you left off.',
  ];

  for (const banner of banners) {
    assert.equal(isInternalContent(banner), false, 'fixture should not be prefix-matchable');
    const raw = {
      type: 'user',
      message: { role: 'user', content: [textPart(banner)] },
      isSynthetic: true,
      uuid: 'u5',
    };
    assert.deepEqual(userTexts(raw), [], banner);
  }
});

test('the persisted isMeta skill preamble stays hidden', () => {
  const raw = {
    type: 'user',
    isMeta: true,
    message: {
      role: 'user',
      content: [textPart('Base directory for this skill: /home/jkready/.claude/skills/start-work\n\n# Start Work Skill')],
    },
    uuid: 'u6',
  };

  assert.deepEqual(userTexts(raw), []);
});

test('subagent sidechain prompts are not attributed to the user', () => {
  const raw = {
    type: 'user',
    isSidechain: true,
    message: { role: 'user', content: [textPart('repo: /tmp/liftosaur-workouts\npr: https://example.test/pull/8')] },
    uuid: 'u7',
  };

  assert.equal(isAgentAuthoredUserTurn(raw), true);
  assert.deepEqual(userTexts(raw), []);
});

test('background task notifications still reach the frontend re-attribution', () => {
  // These are user-role rows that the UI turns into an assistant notification.
  // Suppressing them here would silently drop background-task results.
  const notification = '<task-notification>\n<status>stopped</status>\n<summary>Background task finished</summary>\n</task-notification>';
  const raw = {
    type: 'user',
    message: { role: 'user', content: notification },
    isSynthetic: true,
    uuid: 'u8',
  };

  assert.deepEqual(userTexts(raw), [notification]);
});

test('image-only turns stay a user bubble only when the user sent them', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } };

  const fromUser = provider.normalizeMessage(
    { type: 'user', message: { role: 'user', content: [image] }, uuid: 'u9' },
    'session-1',
  );
  assert.equal(fromUser.length, 1);
  assert.equal(Array.isArray(fromUser[0].images) ? fromUser[0].images.length : 0, 1);

  const fromHarness = provider.normalizeMessage(
    { type: 'user', message: { role: 'user', content: [image] }, isMeta: true, uuid: 'u10' },
    'session-1',
  );
  assert.deepEqual(fromHarness, []);
});

test('agent-authored plain-string content is not attributed to the user', () => {
  // The string-content branch is a separate push site from the array branch,
  // and it is the shape harness banners used before array content became common.
  const flagSets: Array<Record<string, unknown>> = [
    { isMeta: true },
    { isSynthetic: true },
    { isSidechain: true },
    { origin: { kind: 'coordinator' } },
  ];

  for (const flags of flagSets) {
    const raw = {
      type: 'user',
      message: { role: 'user', content: 'The coordinator sent a message while you were working: rebase' },
      uuid: 'u11',
      ...flags,
    };
    assert.deepEqual(userTexts(raw), [], JSON.stringify(flags));
  }
});

test('a malformed origin fails closed to human rather than hiding the message', () => {
  for (const origin of ['peer', { kind: 123 }, null, [], undefined]) {
    const raw = {
      type: 'user',
      message: { role: 'user', content: 'a message I actually typed' },
      origin,
      uuid: 'u12',
    };
    assert.equal(isAgentAuthoredUserTurn(raw), false, JSON.stringify(origin ?? null));
    assert.deepEqual(userTexts(raw), ['a message I actually typed']);
  }
});

/**
 * Dropping `isMeta !== true` from the outer guard means an agent-authored row
 * now reaches the tool_result / compact-summary / local-command branches it was
 * previously short-circuited out of. Those branches never claim the row was
 * typed by the user, so letting them run is intended — these tests pin that
 * decision rather than leaving it to be rediscovered.
 */
test('an agent-authored row still yields its tool result', () => {
  const raw = {
    type: 'user',
    isMeta: true,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok', is_error: false }],
    },
    uuid: 'u13',
  };

  const normalized = provider.normalizeMessage(raw, 'session-1');
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].kind, 'tool_result');
  assert.deepEqual(userTexts(raw), []);
});

test('an agent-authored compact summary is still re-attributed to the assistant', () => {
  const raw = {
    type: 'user',
    isMeta: true,
    isCompactSummary: true,
    message: { role: 'user', content: 'Summary of the conversation so far.' },
    uuid: 'u14',
  };

  const normalized = provider.normalizeMessage(raw, 'session-1');
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].role, 'assistant');
  assert.equal(normalized[0].isCompactSummary, true);
});

test('an agent-authored local-command row still renders as a command chip', () => {
  // Slash commands are a user action even when the transport flags the row, and
  // #41 exists to keep them visible. Suppressing them here would undo that.
  const raw = {
    type: 'user',
    isSynthetic: true,
    message: { role: 'user', content: '<command-name>/review-pr</command-name><command-args>340</command-args>' },
    uuid: 'u15',
  };

  const normalized = provider.normalizeMessage(raw, 'session-1');
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].isLocalCommand, true);
  assert.equal(normalized[0].commandName, '/review-pr');
});

test('an agent-authored local-command stdout is still re-attributed to the assistant', () => {
  const raw = {
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: '<local-command-stdout>branch is up to date</local-command-stdout>' },
    uuid: 'u16',
  };

  const normalized = provider.normalizeMessage(raw, 'session-1');
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].role, 'assistant');
  assert.equal(normalized[0].isLocalCommandStdout, true);
});

test('isInternalContent matches the tagged caveat banner and tolerates leading whitespace', () => {
  assert.equal(
    isInternalContent('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'),
    true,
  );
  assert.equal(isInternalContent('\n\n<system-reminder>hi</system-reminder>'), true);
  assert.equal(isInternalContent('  Base directory for this skill: /x'), true);
  assert.equal(isInternalContent('Please refactor the auth module'), false);
});
