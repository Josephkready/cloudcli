import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_CONFIGS, getToolConfig, shouldHideToolResult } from './toolConfigs';

// toolConfigs drives how each tool call renders: which result rows are hidden,
// and how tool payloads (TodoRead JSON, subagent Task results, plan text) are
// parsed for display. Bugs here silently drop or garble tool output.

// ── getToolConfig: registry lookup with a Default fallback ───────────────────

test('getToolConfig returns the named config, or Default for unknown tools', () => {
  assert.equal(getToolConfig('Bash'), TOOL_CONFIGS.Bash);
  assert.equal(getToolConfig('Read'), TOOL_CONFIGS.Read);
  assert.equal(getToolConfig('NoSuchTool'), TOOL_CONFIGS.Default);
});

// ── shouldHideToolResult: the visibility gate ────────────────────────────────

test('shouldHideToolResult: always-hidden results (Read) are hidden on success', () => {
  assert.equal(shouldHideToolResult('Read', { content: 'file contents' }), true);
});

test('shouldHideToolResult: hideOnSuccess results (Bash) are hidden only with a result present', () => {
  assert.equal(shouldHideToolResult('Bash', { content: 'ok' }), true);
  // hideOnSuccess but no result payload yet -> not hidden.
  assert.equal(shouldHideToolResult('Bash', undefined), false);
  assert.equal(shouldHideToolResult('Bash', null), false);
});

test('shouldHideToolResult: errors are ALWAYS shown, even for hidden/hideOnSuccess tools', () => {
  assert.equal(shouldHideToolResult('Read', { isError: true }), false);
  assert.equal(shouldHideToolResult('Bash', { isError: true, content: 'boom' }), false);
});

test('shouldHideToolResult: a visible/collapsible result (Grep, Default) is not hidden', () => {
  assert.equal(shouldHideToolResult('Grep', { toolUseResult: { numFiles: 2 } }), false);
  assert.equal(shouldHideToolResult('UnknownTool', { content: 'x' }), false);
});

// ── TodoRead result parsing ──────────────────────────────────────────────────

const todoReadProps = (result: unknown) =>
  TOOL_CONFIGS.TodoRead.result!.getContentProps!(result);

test('TodoRead parses a JSON array of todos and marks it as a result', () => {
  const content = JSON.stringify([{ content: 'do it', status: 'pending' }]);
  assert.deepEqual(todoReadProps({ content }), {
    todos: [{ content: 'do it', status: 'pending' }],
    isResult: true,
  });
});

test('TodoRead leaves todos null when the content is not a JSON array', () => {
  assert.deepEqual(todoReadProps({ content: 'plain text' }), { todos: null, isResult: true });
});

test('TodoRead falls back to an empty list when array-looking content is malformed JSON', () => {
  // Starts with '[' so it attempts JSON.parse, which throws -> caught fallback.
  assert.deepEqual(todoReadProps({ content: '[not valid json' }), { todos: [], isResult: true });
});

// ── Task (subagent) result parsing ───────────────────────────────────────────

const taskResultProps = (result: unknown) =>
  TOOL_CONFIGS.Task.result!.getContentProps!(result);

test('Task result joins the text blocks of a serialized content array', () => {
  const content = JSON.stringify([
    { type: 'text', text: 'first' },
    { type: 'tool_use', name: 'Bash' },
    { type: 'text', text: 'second' },
  ]);
  assert.deepEqual(taskResultProps({ content }), { content: 'first\n\nsecond' });
});

test('Task result handles an already-parsed content array', () => {
  assert.deepEqual(taskResultProps({ content: [{ type: 'text', text: 'x' }] }), { content: 'x' });
});

test('Task result reports "No response text" for a text-block-free array', () => {
  const content = JSON.stringify([{ type: 'tool_use', name: 'Bash' }]);
  assert.deepEqual(taskResultProps({ content }), { content: 'No response text' });
});

test('Task result passes non-JSON string content through verbatim', () => {
  assert.deepEqual(taskResultProps({ content: 'just a summary' }), { content: 'just a summary' });
});

test('Task result falls back to "No response" when there is no content', () => {
  assert.deepEqual(taskResultProps(null), { content: 'No response' });
});

// ── Task input formatting ────────────────────────────────────────────────────

const taskInputProps = (input: unknown) =>
  (TOOL_CONFIGS.Task.input.getContentProps as (i: unknown) => { content: string })(input);

test('Task input shows just the prompt when only a prompt is present', () => {
  assert.deepEqual(taskInputProps({ prompt: 'do the thing' }), { content: 'do the thing' });
});

test('Task input renders labeled sections when model/resume are also present', () => {
  const props = taskInputProps({ model: 'opus', prompt: 'go', resume: 'sess-1' });
  assert.equal(props.content, '**Model:** opus\n\n**Prompt:**\ngo\n\n**Resuming from:** sess-1');
});

test('Task input title composes subagent type and description with defaults', () => {
  const title = TOOL_CONFIGS.Task.input.title as (i: unknown) => string;
  assert.equal(title({ subagent_type: 'Explore', description: 'scan' }), 'Subagent / Explore: scan');
  assert.equal(title({}), 'Subagent / Agent: Running task');
});

// ── Edit / Grep / plan / Default ─────────────────────────────────────────────

test('Edit title uses the basename and getContentProps builds a diff payload', () => {
  const title = TOOL_CONFIGS.Edit.input.title as (i: unknown) => string;
  assert.equal(title({ file_path: '/a/b/c/file.ts' }), 'file.ts');
  assert.deepEqual(TOOL_CONFIGS.Edit.input.getContentProps!({
    file_path: '/a/file.ts',
    old_string: 'was',
    new_string: 'now',
  }), {
    oldContent: 'was',
    newContent: 'now',
    filePath: '/a/file.ts',
    badge: 'Edit',
    badgeColor: 'gray',
  });
});

test('Grep result title pluralizes the file count and exposes the filenames', () => {
  const title = TOOL_CONFIGS.Grep.result!.title as (r: unknown) => string;
  assert.equal(title({ toolUseResult: { numFiles: 1 } }), 'Found 1 file');
  assert.equal(title({ toolUseResult: { filenames: ['a', 'b'] } }), 'Found 2 files');
  assert.equal(title({}), 'Found 0 files');
  assert.deepEqual(TOOL_CONFIGS.Grep.result!.getContentProps!({ toolUseResult: { filenames: ['x'] } }), {
    files: ['x'],
  });
});

test('ExitPlanMode unescapes literal \\n sequences in the plan text', () => {
  const props = TOOL_CONFIGS.ExitPlanMode.input.getContentProps!({ plan: 'step 1\\nstep 2' });
  assert.deepEqual(props, { content: 'step 1\nstep 2' });
});

test('Default input stringifies object params as pretty code, strings as-is', () => {
  assert.deepEqual(TOOL_CONFIGS.Default.input.getContentProps!({ a: 1 }), {
    content: JSON.stringify({ a: 1 }, null, 2),
    format: 'code',
  });
  assert.deepEqual(TOOL_CONFIGS.Default.input.getContentProps!('raw' as unknown as object), {
    content: 'raw',
    format: 'code',
  });
});

test('Write title uses the basename and getContentProps builds a "new file" diff', () => {
  const title = TOOL_CONFIGS.Write.input.title as (i: unknown) => string;
  assert.equal(title({ file_path: '/repo/pkg/readme.md' }), 'readme.md');
  // Missing file_path -> the literal 'file' placeholder.
  assert.equal(title({}), 'file');
  assert.deepEqual(TOOL_CONFIGS.Write.input.getContentProps!({ file_path: '/f.ts', content: 'body' }), {
    oldContent: '',
    newContent: 'body',
    filePath: '/f.ts',
    badge: 'New',
    badgeColor: 'green',
  });
});

test('TodoWrite exposes the todos and a fixed success message', () => {
  assert.deepEqual(TOOL_CONFIGS.TodoWrite.input.getContentProps!({ todos: [{ content: 'x' }] }), {
    todos: [{ content: 'x' }],
  });
  assert.equal(TOOL_CONFIGS.TodoWrite.result!.getMessage!({}), 'Todo list updated');
});

test('AskUserQuestion title covers the single/multi and answered/unanswered branches', () => {
  const title = TOOL_CONFIGS.AskUserQuestion.input.title as (i: unknown) => string;
  assert.equal(title({ questions: [{ header: 'Deploy?' }] }), 'Deploy?');
  assert.equal(title({ questions: [{ header: 'Deploy?' }], answers: { 0: 'yes' } }), 'Deploy? — answered');
  // Single question with no header falls back to 'Question'.
  assert.equal(title({ questions: [{}] }), 'Question');
  assert.equal(title({ questions: [{ header: 'a' }, { header: 'b' }] }), '2 questions');
  assert.equal(title({ questions: [{}, {}], answers: { 0: 'x' } }), '2 questions — answered');
  assert.equal(title({}), '0 questions');
});

test('one-line getValue extractors read the expected input field', () => {
  assert.equal(TOOL_CONFIGS.Bash.input.getValue!({ command: 'ls -la' }), 'ls -la');
  assert.equal(TOOL_CONFIGS.Read.input.getValue!({ file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(TOOL_CONFIGS.Read.input.getValue!({}), ''); // missing path -> empty string
  assert.equal(TOOL_CONFIGS.Grep.input.getValue!({ pattern: 'TODO' }), 'TODO');
  assert.equal(TOOL_CONFIGS.Grep.input.getSecondary!({ path: 'src' }), 'in src');
  assert.equal(TOOL_CONFIGS.Grep.input.getSecondary!({}), undefined);
});
