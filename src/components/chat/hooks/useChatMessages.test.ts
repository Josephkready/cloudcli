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
