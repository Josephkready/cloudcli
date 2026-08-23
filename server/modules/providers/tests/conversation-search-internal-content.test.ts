import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  extractClaudeSearchableMessage,
  fileContainsAllSearchTerms,
  isIgnorableRipgrepMissingFileError,
  isInternalCodexContent,
  normalizeSessionSearchTerms,
  normalizeSearchableSessions,
  SearchTermMatcher,
} from '@/modules/providers/services/session-conversations-search.service.js';

/*
 * Conversation search indexes what the user can search *for* (#341).
 *
 * It used to keep a private copy of the internal-content prefix list, which
 * drifted from the provider's: no `<local-command-caveat>` (#340) and no
 * `Base directory for this skill:` (#41). Worse, it read none of the
 * attribution flags, so every harness-authored `role: 'user'` row — stop-hook
 * feedback, skill banners, peer relays, auto-continuation nudges — was indexed
 * as though the user had typed it. Prefix lists cannot keep up; the flags can,
 * and #340 already exported the predicates that read them.
 */

const userRow = (text: string, extra: Record<string, unknown> = {}) => ({
  message: { role: 'user', content: text },
  ...extra,
});

test('the drifted prefixes are now filtered: local-command-caveat banner', () => {
  assert.equal(extractClaudeSearchableMessage(userRow('<local-command-caveat>Caveat: the messages below…')), null);
});

test('the drifted prefixes are now filtered: skill base-directory preamble', () => {
  assert.equal(
    extractClaudeSearchableMessage(userRow('Base directory for this skill: /home/j/.claude/skills/mind')),
    null,
  );
});

test('prefixes already covered stay covered', () => {
  for (const banner of ['<system-reminder>do the thing</system-reminder>', 'Caveat: bare form', '[Request interrupted by user]']) {
    assert.equal(extractClaudeSearchableMessage(userRow(banner)), null, `expected "${banner}" to be internal`);
  }
});

test('a banner emitted with leading whitespace is still filtered', () => {
  assert.equal(extractClaudeSearchableMessage(userRow('\n  <system-reminder>hi</system-reminder>')), null);
});

test('an ordinary user message is still searchable', () => {
  assert.deepEqual(extractClaudeSearchableMessage(userRow('fix the login redirect bug')), {
    text: 'fix the login redirect bug',
    role: 'user',
  });
});

// The point of #341: content prefixes cannot enumerate every harness string, but
// both transports label these rows explicitly. Each flag below is one transport's
// way of saying "the agent wrote this, not the person".
test('agent-authored user turns are not indexed, whatever the harness string is', () => {
  const unseenHarnessText = 'Please continue with the next step of the plan.';

  for (const flags of [
    { isMeta: true },
    { isSynthetic: true },
    { isSidechain: true },
    { origin: { kind: 'agent' } },
    { origin: { kind: 'hook' } },
  ]) {
    assert.equal(
      extractClaudeSearchableMessage(userRow(unseenHarnessText, flags)),
      null,
      `expected ${JSON.stringify(flags)} to mark the row agent-authored`,
    );
  }
});

test('a genuine human turn carrying an explicit human origin is still indexed', () => {
  assert.deepEqual(extractClaudeSearchableMessage(userRow('deploy to staging', { origin: { kind: 'human' } })), {
    text: 'deploy to staging',
    role: 'user',
  });
});

test('a malformed origin fails closed to human rather than silently dropping the row', () => {
  assert.deepEqual(extractClaudeSearchableMessage(userRow('real message', { origin: 'nonsense' })), {
    text: 'real message',
    role: 'user',
  });
});

test('assistant rows are untouched by the user-turn attribution gate', () => {
  assert.deepEqual(
    extractClaudeSearchableMessage({ message: { role: 'assistant', content: 'I fixed it.' } }),
    { text: 'I fixed it.', role: 'assistant' },
  );
});

// Re-attribution branches must keep working: #340 gated only the sites that
// claim a row was typed by the user, and search has the same obligation.
test('a compact summary is still indexed, re-attributed to the assistant', () => {
  assert.deepEqual(
    extractClaudeSearchableMessage({
      message: { role: 'user', content: 'Summary of the conversation so far.' },
      isCompactSummary: true,
      isMeta: true,
    }),
    { text: 'Summary of the conversation so far.', role: 'assistant' },
  );
});

test('array-shaped content is filtered by the same rules', () => {
  assert.equal(
    extractClaudeSearchableMessage({
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>nope</system-reminder>' }] },
    }),
    null,
  );
  assert.equal(
    extractClaudeSearchableMessage({
      message: { role: 'user', content: [{ type: 'text', text: 'a real question' }] },
      isSynthetic: true,
    }),
    null,
  );
});

// #341 also asked whether the Codex list beside it had an equivalent gap. It
// did: a scan of 417 local Codex transcripts found four injected user-role
// wrappers that were being indexed as the user's own words.
test('codex injected boilerplate is treated as internal content', () => {
  for (const banner of [
    '<environment_context>cwd is /repos/x</environment_context>',
    '<recommended_plugins>use the thing</recommended_plugins>',
    '<skill>skill body text</skill>',
    '<turn_aborted>interrupted</turn_aborted>',
    '<subagent_notification>done</subagent_notification>',
  ]) {
    assert.equal(isInternalCodexContent(banner), true, `expected "${banner}" to be internal`);
  }
});

test('an ordinary codex message is not treated as internal', () => {
  assert.equal(isInternalCodexContent('please refactor the parser'), false);
});

test('search normalization filters stale transcript paths asynchronously', async () => {
  const missingPath = '/definitely/missing/cloudcli-session.jsonl';
  const rows = await normalizeSearchableSessions([{
    provider: 'claude',
    jsonl_path: missingPath,
    project_path: '',
  } as never]);

  assert.equal(rows.length, 0);
});

test('ripgrep missing-file races are non-fatal but other I/O errors remain visible', () => {
  assert.equal(
    isIgnorableRipgrepMissingFileError(
      2,
      'rg: /tmp/gone.jsonl: IO error for operation: No such file or directory (os error 2)',
    ),
    true,
  );
  assert.equal(
    isIgnorableRipgrepMissingFileError(2, 'rg: /private/file: Permission denied (os error 13)'),
    false,
  );
  assert.equal(isIgnorableRipgrepMissingFileError(2, ''), false);
});

test('search terms are deduplicated before transcript scanning', () => {
  const query = Array.from({ length: 3000 }, () => 'repeat').join(' ');
  assert.deepEqual(normalizeSessionSearchTerms(`${query} UNIQUE unique`), ['repeat', 'unique']);
});

test('multi-pattern matching handles overlaps and chunks in a single scan', () => {
  const matcher = new SearchTermMatcher(['he', 'she', 'hers']);
  assert.equal(matcher.feed('s'), false);
  assert.equal(matcher.feed('he went to '), false);
  assert.equal(matcher.feed('hers'), true);
});

test('multi-term candidate scans read each file once and handle chunk boundaries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conversation-search-'));
  const matching = path.join(directory, 'matching.jsonl');
  const partial = path.join(directory, 'partial.jsonl');
  try {
    await writeFile(matching, `${'x'.repeat(65_534)}cross-boundary\nsecond term`, 'utf8');
    await writeFile(partial, 'cross-boundary only', 'utf8');

    assert.equal(
      await fileContainsAllSearchTerms(matching, ['cross-boundary', 'second', 'term']),
      true,
    );
    assert.equal(await fileContainsAllSearchTerms(partial, ['cross-boundary', 'second']), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
