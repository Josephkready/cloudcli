import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChatMessage } from '../types/types';

import {
  TOOL_GROUP_THRESHOLD,
  isToolGroupItem,
  groupConsecutiveTools,
  type ToolGroupItem,
} from './toolGrouping';

// groupConsecutiveTools collapses a run of >= TOOL_GROUP_THRESHOLD consecutive
// tool-use messages of the SAME tool into a single ToolGroupItem, so the chat
// doesn't show ten identical "Read" rows. These pin the run/break rules.

const tool = (toolName: string, extra: Record<string, unknown> = {}): ChatMessage =>
  ({ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', isToolUse: true, toolName, ...extra } as unknown as ChatMessage);

const plain = (extra: Record<string, unknown> = {}): ChatMessage =>
  ({ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', ...extra } as unknown as ChatMessage);

const asGroup = (item: unknown): ToolGroupItem => {
  assert.ok(isToolGroupItem(item as never), 'expected a tool group item');
  return item as ToolGroupItem;
};

test('the grouping threshold is 2', () => {
  assert.equal(TOOL_GROUP_THRESHOLD, 2);
});

test('isToolGroupItem distinguishes groups from plain messages', () => {
  assert.equal(isToolGroupItem(plain() as never), false);
  const [group] = groupConsecutiveTools([tool('Bash'), tool('Bash')]);
  assert.equal(isToolGroupItem(group), true);
});

test('collapses two+ consecutive same-tool messages into one group', () => {
  const items = groupConsecutiveTools([tool('Bash'), tool('Bash'), tool('Bash')]);
  assert.equal(items.length, 1);
  const group = asGroup(items[0]);
  assert.equal(group.toolName, 'Bash');
  assert.equal(group.messages.length, 3);
});

test('a lone tool message is left ungrouped', () => {
  const items = groupConsecutiveTools([tool('Bash')]);
  assert.equal(items.length, 1);
  assert.equal(isToolGroupItem(items[0]), false);
});

test('different adjacent tools are not merged', () => {
  const items = groupConsecutiveTools([tool('Bash'), tool('Read')]);
  assert.equal(items.length, 2);
  assert.equal(items.every((i) => !isToolGroupItem(i)), true);
});

test('a group ends at a non-tool message, then a new run can start', () => {
  const items = groupConsecutiveTools([tool('Bash'), tool('Bash'), plain({ content: 'note' }), tool('Read'), tool('Read')]);
  assert.equal(items.length, 3);
  assert.equal(asGroup(items[0]).toolName, 'Bash');
  assert.equal(isToolGroupItem(items[1]), false);
  assert.equal(asGroup(items[2]).toolName, 'Read');
});

test('hidden thinking between tools does not break the run (showThinking=false)', () => {
  const msgs = [tool('Bash'), plain({ isThinking: true }), tool('Bash')];
  const items = groupConsecutiveTools(msgs, false);
  assert.equal(items.length, 1);
  assert.equal(asGroup(items[0]).messages.length, 2);
});

test('visible thinking DOES break the run (showThinking=true)', () => {
  const msgs = [tool('Bash'), plain({ isThinking: true }), tool('Bash')];
  const items = groupConsecutiveTools(msgs, true);
  assert.equal(items.length, 3);
  assert.equal(items.every((i) => !isToolGroupItem(i)), true);
});

test('tool messages with an unresolved (empty) toolName are not groupable', () => {
  // isToolUse can be set before the tool name resolves; a falsy toolName must
  // not let two such messages collapse into a nameless group.
  const items = groupConsecutiveTools([tool(''), tool('')]);
  assert.equal(items.length, 2);
  assert.equal(items.every((i) => !isToolGroupItem(i)), true);
});

test('subagent-container tool messages are not groupable', () => {
  const items = groupConsecutiveTools([
    tool('Task', { isSubagentContainer: true }),
    tool('Task', { isSubagentContainer: true }),
  ]);
  assert.equal(items.length, 2);
  assert.equal(items.every((i) => !isToolGroupItem(i)), true);
});
