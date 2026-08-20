import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveOpeningName, needsOpeningName } from './sessionOpeningName.js';

/*
 * #368 — every conversation was titled "New Session" unless the AI titler was on.
 *
 * The titler's own docstring says it "rewrites long first-prompt session titles
 * into short ones", i.e. the design already assumes `custom_name` holds the
 * opening prompt and the worker only shortens it. App-created sessions never got
 * that far: the row is created before the first message exists, so nothing ever
 * wrote the prompt into it. These cover the pure half of the fix.
 */

test('derives a title from the opening message', () => {
    assert.equal(deriveOpeningName('Show me a long code sample'), 'Show me a long code sample');
});

test('collapses whitespace so a multi-line prompt renders on one row', () => {
    assert.equal(
        deriveOpeningName('  Fix   the\n\tlogin   bug  '),
        'Fix the login bug',
    );
});

test('returns null for anything unusable, so the row is left alone', () => {
    for (const empty of ['', '   ', '\n\t ', null, undefined]) {
        assert.equal(deriveOpeningName(empty), null, `expected null for ${JSON.stringify(empty)}`);
    }
});

test('refuses slash commands, which name the command and not the conversation', () => {
    // "/model" is no more navigable than "New Session", and the next message is
    // a better source than the command's arguments.
    for (const command of ['/model', '/model opus', '/cost', '  /help  ']) {
        assert.equal(deriveOpeningName(command), null, `expected null for ${command}`);
    }
});

test('truncates a long opening line at a word boundary', () => {
    const long = 'Please explain in detail how the session synchronizer decides which name to keep when a title event and a first prompt disagree';
    const derived = deriveOpeningName(long);

    assert.ok(derived, 'expected a derived name');
    assert.ok(derived.length <= 81, `expected <= 81 chars (80 + ellipsis), got ${derived.length}`);
    assert.ok(derived.endsWith('…'), `expected an ellipsis, got ${JSON.stringify(derived)}`);

    const body = derived.slice(0, -1);
    assert.ok(long.startsWith(body), 'derived name is not a prefix of the message');
    // Word boundary means the ORIGINAL continues with a space at the cut point —
    // not that the derived string has a space before its ellipsis, which a
    // boundary cut never produces.
    assert.equal(long[body.length], ' ', `truncated mid-word: ${JSON.stringify(derived)}`);
});

test('a single very long token still yields a bounded name', () => {
    // A pasted URL or stack frame has no space to break on. Falling back to a
    // hard clip is right; collapsing to almost nothing would not be.
    const derived = deriveOpeningName(`https://example.com/${'a'.repeat(400)}`);

    assert.ok(derived, 'expected a derived name');
    assert.ok(derived.length <= 81, `expected <= 81 chars, got ${derived.length}`);
    assert.ok(derived.length > 40, `expected a useful prefix, got ${derived.length} chars`);
});

test('a name is needed when the row has none', () => {
    for (const blank of [null, undefined, '', '   ']) {
        assert.equal(needsOpeningName(blank), true, `expected true for ${JSON.stringify(blank)}`);
    }
});

test('synchronizer placeholders count as unnamed, for every provider', () => {
    // These carry no more information than an empty string, so a real opening
    // line should be allowed to replace them. Antigravity is the one an
    // enumerated list originally missed: its placeholder is also excluded from
    // the AI titler by `custom_name NOT LIKE 'Untitled % Session'`, so a session
    // stuck on it would have had no route to a name at all.
    for (const placeholder of [
        'Untitled Claude Session',
        'Untitled Codex Session',
        'Untitled Antigravity Session',
        'untitled session',
        'New Session',
    ]) {
        assert.equal(needsOpeningName(placeholder), true, `expected true for ${placeholder}`);
    }
});

test('a provider added later is covered without touching this file', () => {
    // The pattern mirrors getSessionsNeedingAiTitle's SQL filter, so the two
    // cannot drift apart the way an enumerated list would.
    assert.equal(needsOpeningName('Untitled Gemini Session'), true);
    assert.equal(needsOpeningName('Untitled Some New Provider Session'), true);
    // ...without swallowing a real title that merely mentions a session.
    assert.equal(needsOpeningName('Untitled draft about my session notes'), false);
    assert.equal(needsOpeningName('Debug the untitled session bug'), false);
});

test('a real name is never overwritten', () => {
    // Covers a user rename and an AI-generated title alike: once the row says
    // something, this must not touch it.
    for (const named of ['Fix the login bug', 'Untitled Claude Session extras', 'A']) {
        assert.equal(needsOpeningName(named), false, `expected false for ${named}`);
    }
});
