import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

let seq = 0;
const nm = (partial: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: `m${seq++}`,
  sessionId: 's1',
  timestamp: '2026-07-18T00:00:00.000Z',
  provider: 'codex',
  kind: 'text',
  ...partial,
});

const edit = (toolId: string, filePath: string, toolResult?: NormalizedMessage['toolResult']): NormalizedMessage =>
  nm({ kind: 'tool_use', toolName: 'Edit', toolInput: { file_path: filePath }, toolId, toolResult });

const result = (toolId: string, content: string, isError = false): NormalizedMessage =>
  nm({ kind: 'tool_result', toolId, content, isError });

const toolUses = (msgs: ReturnType<typeof normalizedToChatMessages>) => msgs.filter((m) => m.isToolUse);

test('multi-file Codex apply_patch renders the shared result on only one Edit (#119)', () => {
  // Mirrors the provider output: one apply_patch → three Edits sharing a call_id,
  // the shared result pre-attached to the last Edit, plus the standalone result.
  const messages: NormalizedMessage[] = [
    edit('call-1', 'src/a.ts'),
    edit('call-1', 'src/b.ts'),
    edit('call-1', 'src/c.ts', { content: 'Success. Updated 3 files', isError: false }),
    result('call-1', 'Success. Updated 3 files'),
  ];

  const tools = toolUses(normalizedToChatMessages(messages));

  assert.equal(tools.length, 3);
  const withResult = tools.filter((t) => t.toolResult);
  assert.equal(withResult.length, 1, 'result should render on exactly one Edit');
  assert.equal(String(withResult[0].toolInput).includes('src/c.ts'), true, 'result belongs to the last file');
  assert.equal(withResult[0].toolResult?.content, 'Success. Updated 3 files');
});

test('single-file Edit still shows its result via the standalone-result fallback', () => {
  // No inline toolResult — the fallback map must still attach the result.
  const messages: NormalizedMessage[] = [
    edit('call-1', 'src/only.ts'),
    result('call-1', 'Success. Updated 1 file'),
  ];

  const tools = toolUses(normalizedToChatMessages(messages));

  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolResult?.content, 'Success. Updated 1 file');
});

test('an errored multi-file patch result renders once, as an error', () => {
  const messages: NormalizedMessage[] = [
    edit('call-1', 'src/a.ts'),
    edit('call-1', 'src/b.ts', { content: 'patch failed', isError: true }),
    result('call-1', 'patch failed', true),
  ];

  const tools = toolUses(normalizedToChatMessages(messages));
  const withResult = tools.filter((t) => t.toolResult);

  assert.equal(withResult.length, 1);
  assert.equal(withResult[0].toolResult?.isError, true);
  assert.equal(withResult[0].toolResult?.content, 'patch failed');
});

test('independent call_ids each render their own result', () => {
  const messages: NormalizedMessage[] = [
    edit('call-1', 'src/a.ts', { content: 'first', isError: false }),
    result('call-1', 'first'),
    edit('call-2', 'src/b.ts', { content: 'second', isError: false }),
    result('call-2', 'second'),
  ];

  const tools = toolUses(normalizedToChatMessages(messages));

  assert.equal(tools.length, 2);
  assert.equal(tools[0].toolResult?.content, 'first');
  assert.equal(tools[1].toolResult?.content, 'second');
});

test('a contentless inline tool_result does not throw and renders as empty (#463)', () => {
  // The inline-result branch passes tr.content unguarded, so a tool result whose
  // `content` is absent used to hit JSON.stringify(undefined) -> undefined and throw
  // on .trim(), taking down the whole transcript render.
  const messages: NormalizedMessage[] = [
    edit('call-1', 'src/a.ts', { content: undefined as unknown as string, isError: false }),
  ];

  const tools = toolUses(normalizedToChatMessages(messages));

  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolResult?.content, '');
});

test('a contentless standalone-result fallback does not throw and renders as empty (#463)', () => {
  // The structurally distinct path: no inline result, so the result is attached via
  // the toolResultMap fallback. It reaches the same formatToolResultContent call and
  // must be equally safe when the standalone result has no content.
  const messages: NormalizedMessage[] = [
    edit('call-1', 'src/only.ts'),
    result('call-1', undefined as unknown as string),
  ];

  const tools = toolUses(normalizedToChatMessages(messages));

  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolResult?.content, '');
});

// --- incremental derivation (per-row memoization keyed on row identity) ---
//
// `normalizedToChatMessages` caches each row's converted output keyed on the
// row's own object reference (the store never mutates a NormalizedMessage in
// place, so reference identity already is "content version"). These tests
// observe that cache through the only thing callers can see: whether the
// SAME output ChatMessage object comes back across two calls for a row whose
// reference didn't change.

test('an unchanged prefix is not recomputed: same row references return the same ChatMessage objects', () => {
  const a = nm({ kind: 'text', role: 'assistant', content: 'settled one' });
  const b = nm({ kind: 'text', role: 'assistant', content: 'settled two' });
  const streamV1 = nm({ kind: 'stream_delta', content: 'Hel' });

  const first = normalizedToChatMessages([a, b, streamV1]);
  const streamV2 = nm({ kind: 'stream_delta', content: 'Hello wor' }); // simulates updateStreaming's tick
  const second = normalizedToChatMessages([a, b, streamV2]);

  assert.equal(second[0], first[0], 'row a unchanged -> same output object reused');
  assert.equal(second[1], first[1], 'row b unchanged -> same output object reused');
  assert.notEqual(second[2], first[2], 'the replaced streaming row must get a fresh object');
  assert.equal(second[2].content, 'Hello wor');
});

test('a new chunk only touches the tail: an appended row does not disturb earlier cached output', () => {
  const a = nm({ kind: 'text', role: 'assistant', content: 'one' });
  const b = nm({ kind: 'text', role: 'assistant', content: 'two' });

  const first = normalizedToChatMessages([a, b]);
  const c = nm({ kind: 'text', role: 'assistant', content: 'three' });
  const second = normalizedToChatMessages([a, b, c]);

  assert.equal(second.length, 3);
  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[1]);
  assert.equal(second[2].content, 'three');
});

test('a compaction/replace (whole array swapped for new row objects) re-derives everything', () => {
  const first = normalizedToChatMessages([
    nm({ kind: 'text', role: 'assistant', content: 'one' }),
    nm({ kind: 'text', role: 'assistant', content: 'two' }),
  ]);

  // Same values, but every row is a brand-new object -- e.g. a fresh transcript
  // fetch that replaced `serverMessages` wholesale.
  const second = normalizedToChatMessages([
    nm({ kind: 'text', role: 'assistant', content: 'one' }),
    nm({ kind: 'text', role: 'assistant', content: 'two' }),
  ]);

  assert.equal(second.length, first.length);
  assert.notEqual(second[0], first[0]);
  assert.notEqual(second[1], first[1]);
  assert.deepEqual(
    second.map((m) => m.content),
    first.map((m) => m.content),
  );
});

test('a standalone tool_result arriving on a later call updates the earlier, unchanged tool_use row (not served stale from cache)', () => {
  // The hazard this cache exists to avoid: `tool_use`'s rendered result can
  // depend on a DIFFERENT row (a standalone tool_result) that shows up later,
  // while the tool_use row's own reference never changes.
  const toolUse = edit('call-1', 'src/only.ts'); // no inline toolResult

  const first = toolUses(normalizedToChatMessages([toolUse]));
  assert.equal(first.length, 1);
  assert.equal(first[0].toolResult, null, 'no result yet -> unset');

  const resultRow = result('call-1', 'Success. Updated 1 file');
  const second = toolUses(normalizedToChatMessages([toolUse, resultRow]));

  assert.equal(second.length, 1);
  assert.equal(
    second[0].toolResult?.content,
    'Success. Updated 1 file',
    'the tool_use row must pick up its result once the tool_result row appears, even though its own reference is unchanged',
  );
  assert.notEqual(second[0], first[0], 'the tool_use row\'s output must be fresh, not the stale cached "no result" render');

  // And once the result is attached, a further call with the exact same two
  // rows must reuse the (now-correct) cached output rather than recompute.
  const third = toolUses(normalizedToChatMessages([toolUse, resultRow]));
  assert.equal(third[0], second[0], 'stable inputs -> cached output reused');
});

test('a multi-file patch owner Edit arriving later still leaves its unrelated siblings correct (inlineResultToolIds membership can flip after they were cached)', () => {
  // Mirrors #119's shape, but with the shared-result-carrying "owner" Edit
  // appended on a LATER call than its siblings, so inlineResultToolIds gains a
  // member (call-1) after the siblings were already cached without it. This is
  // allowed to force a cache miss on those siblings (their resultRef read
  // through `inlineResultToolIds`), but their rendered output must stay
  // correct regardless.
  const siblingA = edit('call-1', 'src/a.ts');
  const siblingB = edit('call-1', 'src/b.ts');

  const first = toolUses(normalizedToChatMessages([siblingA, siblingB]));
  assert.equal(first.length, 2);
  assert.equal(first[0].toolResult, null);
  assert.equal(first[1].toolResult, null);

  const owner = edit('call-1', 'src/c.ts', { content: 'Success. Updated 3 files', isError: false });
  const second = toolUses(normalizedToChatMessages([siblingA, siblingB, owner]));

  assert.equal(second.length, 3);
  assert.equal(second[0].toolResult, null, 'sibling A must still show no result once the owner appears');
  assert.equal(second[1].toolResult, null, 'sibling B must still show no result once the owner appears');
  assert.equal(second[2].toolResult?.content, 'Success. Updated 3 files', 'the owner Edit carries the result');
});
