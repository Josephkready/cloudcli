import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractTitleCandidatesFromLines,
  pickDiscoveredSessionName,
  readableUserPrompt,
} from '@/modules/providers/list/claude/session-title.js';

test('a user rename (custom-title) wins over everything', () => {
  assert.equal(
    pickDiscoveredSessionName(
      { customTitle: 'My Renamed Session', aiTitle: 'AI Title', lastPrompt: 'last thing typed' },
      'the first prompt I typed',
    ),
    'My Renamed Session',
  );
});

test('the ai-title is preferred over the first-prompt display (the #5 fix)', () => {
  assert.equal(
    pickDiscoveredSessionName(
      { aiTitle: 'Refactor the auth flow' },
      'can you refactor the auth flow please and also handle the edge cases',
    ),
    'Refactor the auth flow',
  );
});

test('the ai-title also wins over a more recent last-prompt', () => {
  assert.equal(
    pickDiscoveredSessionName({ aiTitle: 'Design the deploy doc', lastPrompt: 'ok now do X' }, 'first prompt'),
    'Design the deploy doc',
  );
});

test('falls back to the first-prompt display when no ai/custom title exists', () => {
  assert.equal(
    pickDiscoveredSessionName({ lastPrompt: 'the last thing I typed' }, 'the first thing I typed'),
    'the first thing I typed',
  );
});

test('falls back to last-prompt when there is no title and no first-prompt display', () => {
  assert.equal(
    pickDiscoveredSessionName({ lastPrompt: 'the last thing I typed' }, undefined),
    'the last thing I typed',
  );
});

test('an empty/whitespace first-prompt display is treated as absent (falls through to last-prompt)', () => {
  assert.equal(pickDiscoveredSessionName({ lastPrompt: 'fallback' }, '   '), 'fallback');
  assert.equal(pickDiscoveredSessionName({ lastPrompt: 'fallback' }, ''), 'fallback');
});

test('an empty display with no other candidate yields undefined (caller normalizes)', () => {
  assert.equal(pickDiscoveredSessionName({}, ''), undefined);
});

test('returns undefined when nothing is available', () => {
  assert.equal(pickDiscoveredSessionName({}, undefined), undefined);
});

// --- extractTitleCandidatesFromLines (the transcript scan) ---

const S = 'sess-123';
const line = (obj: object) => JSON.stringify(obj);

test('scan: keeps the most-recent value of each title type (newest-first)', () => {
  const lines = [
    line({ type: 'ai-title', aiTitle: 'Old Title', sessionId: S }),
    line({ type: 'user', text: 'a message', sessionId: S }),
    line({ type: 'ai-title', aiTitle: 'Newest Title', sessionId: S }),
    line({ type: 'last-prompt', lastPrompt: 'do the thing', sessionId: S }),
    line({ type: 'custom-title', customTitle: 'Renamed', sessionId: S }),
  ];
  const c = extractTitleCandidatesFromLines(lines, S);
  assert.equal(c.aiTitle, 'Newest Title'); // not the older 'Old Title'
  assert.equal(c.lastPrompt, 'do the thing');
  assert.equal(c.customTitle, 'Renamed');
});

test('scan: skips events belonging to a different session', () => {
  const lines = [
    line({ type: 'ai-title', aiTitle: 'Other Session', sessionId: 'other' }),
    line({ type: 'ai-title', aiTitle: 'Mine', sessionId: S }),
  ];
  assert.equal(extractTitleCandidatesFromLines(lines, S).aiTitle, 'Mine');
});

test('scan: skips blank and non-JSON lines', () => {
  const lines = ['', '   ', 'not json {', line({ type: 'ai-title', aiTitle: 'Good', sessionId: S })];
  assert.equal(extractTitleCandidatesFromLines(lines, S).aiTitle, 'Good');
});

test('scan: an empty/whitespace title value does not claim the slot', () => {
  const lines = [
    line({ type: 'ai-title', aiTitle: 'Real', sessionId: S }),     // older, real
    line({ type: 'ai-title', aiTitle: '   ', sessionId: S }),      // newer, blank → ignored
  ];
  assert.equal(extractTitleCandidatesFromLines(lines, S).aiTitle, 'Real');
});

test('scan: trims stored values', () => {
  const lines = [line({ type: 'ai-title', aiTitle: '  Padded Title  ', sessionId: S })];
  assert.equal(extractTitleCandidatesFromLines(lines, S).aiTitle, 'Padded Title');
});

test('scan: returns an empty object when there are no title events', () => {
  assert.deepEqual(extractTitleCandidatesFromLines([line({ type: 'user', text: 'hi', sessionId: S })], S), {});
});


/*
 * A session whose prompts were all slash commands never got a name
 * (cloudcli#503/#505, reported twice against the same session).
 *
 * Claude Code writes a `last-prompt` event for such a turn carrying only
 * `{ type, leafUuid, sessionId }` — the `lastPrompt` text field is simply
 * absent — and writes no `ai-title`. An app-created session has no
 * history.jsonl entry either, so every candidate came up empty and the row sat
 * at the "Untitled Claude Session" placeholder for good. The shapes below are
 * taken from the real transcript on the reported session.
 */

/** The `last-prompt` shape a slash-command turn actually produces. */
const textlessLastPrompt = (sessionId: string) =>
  line({ type: 'last-prompt', leafUuid: 'cdbef10d-35cc-4725-89f5-50f2603a00bc', sessionId });

/** A `user` row holding Claude Code's slash-command envelope. */
const slashCommandUserRow = (sessionId: string, name: string, args: string) =>
  line({
    type: 'user',
    sessionId,
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: `<command-name>${name}</command-name>\n<command-message>${name.replace('/', '')}</command-message>\n<command-args>${args}</command-args>`,
      }],
    },
  });

test('slash-command session: falls back to the opening prompt when every title event is textless', () => {
  const lines = [
    line({ type: 'queue-operation', sessionId: S }),
    slashCommandUserRow(S, '/goal', 'go through this repo and reduce code'),
    textlessLastPrompt(S),
    textlessLastPrompt(S),
  ];

  const candidates = extractTitleCandidatesFromLines(lines, S);
  assert.equal(candidates.lastPrompt, undefined, 'a textless last-prompt must not claim the slot');
  assert.equal(candidates.firstUserPrompt, '/goal go through this repo and reduce code');
  assert.equal(
    pickDiscoveredSessionName(candidates, undefined),
    '/goal go through this repo and reduce code',
  );
});

test('the opening prompt is the weakest candidate', () => {
  const candidates = { lastPrompt: 'something typed later', firstUserPrompt: '/goal the opening line' };
  assert.equal(pickDiscoveredSessionName(candidates, undefined), 'something typed later');
  assert.equal(pickDiscoveredSessionName(candidates, 'history.jsonl display'), 'history.jsonl display');
  assert.equal(
    pickDiscoveredSessionName({ aiTitle: 'A Real Title', firstUserPrompt: '/goal x' }, undefined),
    'A Real Title',
  );
});

test('the opening prompt is not read at all when a title event already answered', () => {
  // Load-bearing: the scan above runs from the END of the file, and this one
  // runs from the start. A long transcript must not pay for both.
  const lines = [
    slashCommandUserRow(S, '/goal', 'the opening line'),
    line({ type: 'ai-title', aiTitle: 'A Real Title', sessionId: S }),
  ];
  assert.equal(extractTitleCandidatesFromLines(lines, S).firstUserPrompt, undefined);
});

test('the opening prompt ignores other sessions and non-typed user rows', () => {
  const lines = [
    slashCommandUserRow('other-session', '/goal', 'not this one'),
    // A tool result: user-role, but structured content rather than typed text.
    line({
      type: 'user',
      sessionId: S,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    }),
    slashCommandUserRow(S, '/goal', 'this one'),
  ];
  assert.equal(extractTitleCandidatesFromLines(lines, S).firstUserPrompt, '/goal this one');
});

test('a plain typed prompt survives the fallback unchanged', () => {
  const lines = [
    line({ type: 'user', sessionId: S, message: { role: 'user', content: 'just fix the header please' } }),
  ];
  assert.equal(extractTitleCandidatesFromLines(lines, S).firstUserPrompt, 'just fix the header please');
});

test('readableUserPrompt renders the envelope as the typed line', () => {
  assert.equal(
    readableUserPrompt('<command-name>/goal</command-name>\n<command-args>reduce code</command-args>'),
    '/goal reduce code',
  );
  // A bare command with no arguments.
  assert.equal(readableUserPrompt('<command-name>/clear</command-name>'), '/clear');
  // Claude Code is inconsistent about the leading slash.
  assert.equal(readableUserPrompt('<command-name>goal</command-name>'), '/goal');
  // Plain text is untouched...
  assert.equal(readableUserPrompt('just some words'), 'just some words');
  // ...and stray markup never reaches the sidebar.
  assert.equal(readableUserPrompt('<command-message>orphan</command-message>'), 'orphan');
  assert.equal(readableUserPrompt('   '), '');
});
