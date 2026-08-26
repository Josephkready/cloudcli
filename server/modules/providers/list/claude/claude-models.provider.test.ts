import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_FALLBACK_MODELS,
  ClaudeProviderModels,
  findClaudeModelOption,
  isPlaceholderModelValue,
  resolveClaudeSessionModelFromTranscript,
} from '@/modules/providers/list/claude/claude-models.provider.js';

// Effort tiers the Claude Code CLI accepts. A catalog entry offering anything
// outside this set would surface a picker option the CLI rejects at run time.
const CLAUDE_EFFORT_TIERS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

test('every catalog entry has a unique value', () => {
  const values = CLAUDE_FALLBACK_MODELS.OPTIONS.map((option) => option.value);
  assert.equal(new Set(values).size, values.length, `duplicate model values: ${values.join(', ')}`);
});

test('the catalog DEFAULT resolves to a listed option', () => {
  assert.ok(
    findClaudeModelOption(CLAUDE_FALLBACK_MODELS.DEFAULT),
    `DEFAULT "${CLAUDE_FALLBACK_MODELS.DEFAULT}" is not present in OPTIONS`,
  );
});

test('every option offers only effort tiers the CLI accepts', () => {
  for (const option of CLAUDE_FALLBACK_MODELS.OPTIONS) {
    for (const { value } of option.effort?.values ?? []) {
      assert.ok(
        CLAUDE_EFFORT_TIERS.has(value),
        `model "${option.value}" offers unknown effort tier "${value}"`,
      );
    }
  }
});

test('every effort-capable option defaults to a tier it actually offers', () => {
  for (const option of CLAUDE_FALLBACK_MODELS.OPTIONS) {
    const defaultEffort = option.effort?.default;
    if (!defaultEffort) {
      continue;
    }

    const offered = option.effort?.values.map((entry) => entry.value) ?? [];
    assert.ok(
      offered.includes(defaultEffort),
      `model "${option.value}" defaults to effort "${defaultEffort}" but only offers ${offered.join(', ')}`,
    );
  }
});

test('the Opus and Sonnet entries expose the full Opus 5 / Sonnet 5 effort ladder', () => {
  // Both generations support xhigh. resolveClaudeEffort() gates on this list, so
  // omitting a tier here silently drops the user's effort selection.
  for (const model of ['default', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'fable']) {
    const offered = findClaudeModelOption(model)?.effort?.values.map((entry) => entry.value) ?? [];
    assert.deepEqual(
      offered,
      ['low', 'medium', 'high', 'xhigh', 'max'],
      `model "${model}" does not offer the full effort ladder`,
    );
  }
});

test('findClaudeModelOption trims input and rejects blank or unknown models', () => {
  assert.equal(findClaudeModelOption('  opus[1m]  ')?.value, 'opus[1m]');
  assert.equal(findClaudeModelOption('   '), null);
  assert.equal(findClaudeModelOption(undefined), null);
  assert.equal(findClaudeModelOption('not-a-real-model'), null);
});

// ---------------------------------------------------------------------------
// Transcript model resolution — the `<synthetic>` placeholder guard.
//
// Claude Code stamps turns it fabricates locally (API-error notices, aborted
// turns) with `model: "<synthetic>"`. Resolving a session's model from the
// transcript must never adopt that: it is the value the model picker labels the
// session with, and `changeActiveModel` records the picker's value as the model
// the next resumed turn runs on.
// ---------------------------------------------------------------------------

const SESSION_ID = '77af7791-311d-4f0e-abbf-381f25ed775a';

/** One assistant turn, as Claude Code writes it into the session JSONL. */
const assistantTurn = (model: string, text = 'ok', sessionId = SESSION_ID): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId,
    message: { role: 'assistant', model, content: [{ type: 'text', text }] },
  });

/** The row Claude writes when a turn fails against the API. */
const syntheticTurn = (text = 'API Error: 529 overloaded_error'): string =>
  assistantTurn('<synthetic>', text);

const transcript = (...lines: string[]): string => `${lines.join('\n')}\n`;

test('isPlaceholderModelValue rejects angle-bracketed sentinels, not real model ids', () => {
  for (const placeholder of ['<synthetic>', '<none>', '<unknown>', '<>', '  <synthetic>  ']) {
    assert.equal(isPlaceholderModelValue(placeholder), true, `${placeholder} should be a placeholder`);
  }

  // Every id in our own catalog must survive the guard, plus a dated API id.
  for (const option of CLAUDE_FALLBACK_MODELS.OPTIONS) {
    assert.equal(
      isPlaceholderModelValue(option.value),
      false,
      `catalog model "${option.value}" must not be treated as a placeholder`,
    );
  }

  for (const real of ['claude-opus-4-5-20260101', 'opus[1m]', 'a<b>', '<opus', 'opus>']) {
    assert.equal(isPlaceholderModelValue(real), false, `${real} should not be a placeholder`);
  }
});

test('a transcript whose only model is <synthetic> resolves to nothing', () => {
  const jsonl = transcript(
    JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { role: 'user', content: 'hi' } }),
    syntheticTurn(),
  );

  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl), null);
});

test('a mixed transcript resolves to the most recent REAL model, not the newest synthetic one', () => {
  // Newest-last on disk: opus, then a /model switch to sonnet, then the API
  // blew up twice. The answer is sonnet — the last model actually in use — and
  // must be neither `<synthetic>` (newest) nor opus (stale).
  const jsonl = transcript(
    assistantTurn('opus'),
    assistantTurn('sonnet'),
    syntheticTurn(),
    syntheticTurn('API Error: 500'),
  );

  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl), 'sonnet');
});

test('synthetic turns interleaved between real ones do not shadow the newer real model', () => {
  const jsonl = transcript(
    assistantTurn('opus'),
    syntheticTurn(),
    assistantTurn('sonnet[1m]'),
    syntheticTurn(),
  );

  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl), 'sonnet[1m]');
});

test('a transcript with no model at all resolves to nothing', () => {
  const jsonl = transcript(
    JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'summary', summary: 'A chat' }),
  );

  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl), null);
});

test('an empty transcript resolves to nothing', () => {
  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, ''), null);
  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, '\n\n  \n'), null);
});

test('the top-level event model is guarded too, and falls through to an older real turn', () => {
  const jsonl = transcript(
    assistantTurn('haiku'),
    JSON.stringify({ type: 'system', subtype: 'init', sessionId: SESSION_ID, model: '<synthetic>' }),
  );

  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl), 'haiku');
});

test('a <model> tag holding a placeholder is skipped, but a real one is honoured', () => {
  const real = transcript(
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      message: { role: 'user', content: '<model>opus[1m]</model>' },
    }),
  );
  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, real), 'opus[1m]');

  const placeholder = transcript(
    assistantTurn('fable'),
    JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      message: { role: 'user', content: '<model><synthetic></model>' },
    }),
  );
  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, placeholder), 'fable');
});

test('a /model stdout announcing a placeholder does not shadow the real <model> tag beside it', () => {
  const content = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>sonnet</model>';
  const jsonl = transcript(
    JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { role: 'user', content } }),
  );

  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl), 'sonnet');
});

test('a real /model stdout switch is still read', () => {
  const content = '<local-command-stdout>Set model to opus.</local-command-stdout>';
  const jsonl = transcript(
    assistantTurn('haiku'),
    JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { role: 'user', content } }),
  );

  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl), 'opus');
});

test('turns belonging to another session are ignored, synthetic or not', () => {
  const jsonl = transcript(
    assistantTurn('sonnet'),
    assistantTurn('opus', 'ok', 'a-different-session'),
    syntheticTurn(),
  );

  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl), 'sonnet');
});

test('malformed JSONL lines are skipped without hiding a real model', () => {
  const jsonl = transcript(
    assistantTurn('opus'),
    '{"type":"assistant","message":{"model":"sonnet"',
    syntheticTurn(),
  );

  assert.equal(resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl), 'opus');
});

test('no resolved model falls back to the catalog default, which is a real picker option', async () => {
  // getCurrentActiveModel() with no session takes the same fallback branch the
  // resolver's null return feeds into.
  const activeModel = await new ClaudeProviderModels().getCurrentActiveModel();

  assert.deepEqual(activeModel, { model: 'default' });
  assert.equal(activeModel.model, CLAUDE_FALLBACK_MODELS.DEFAULT);
  assert.ok(findClaudeModelOption(activeModel.model), 'the fallback must be a selectable option');
});

test('no transcript can ever resolve to an angle-bracketed value', () => {
  // Belt-and-braces: the property that actually matters downstream.
  const jsonl = transcript(
    syntheticTurn(),
    JSON.stringify({ type: 'system', sessionId: SESSION_ID, model: '<future-placeholder>' }),
    assistantTurn('<another>'),
  );

  const resolved = resolveClaudeSessionModelFromTranscript(SESSION_ID, jsonl);
  assert.equal(resolved, null);
});
