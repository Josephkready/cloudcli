import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeLocalCommandDisplayText,
  escapeRegex,
  extractTaggedContent,
  isVisibleCodexUserMessage,
  parseClaudeLocalCommandPayload,
  stripAnsiFormatting,
} from '@/modules/providers/shared/transcript/transcript-text.js';

const ESC = String.fromCharCode(0x1b);

test('escapeRegex neutralizes every regex metacharacter', () => {
  const metacharacters = '.*+?^${}()|[]\\';
  const pattern = new RegExp(escapeRegex(metacharacters));
  assert.equal(pattern.test(metacharacters), true);
  assert.equal(pattern.test('anything else'), false);
});

test('extractTaggedContent returns the inner text, including across newlines', () => {
  assert.equal(extractTaggedContent('<command-name>/goal</command-name>', 'command-name'), '/goal');
  assert.equal(extractTaggedContent('<a>line one\nline two</a>', 'a'), 'line one\nline two');
});

test('extractTaggedContent returns null when the tag is absent or unclosed', () => {
  assert.equal(extractTaggedContent('no tags here', 'command-name'), null);
  assert.equal(extractTaggedContent('<command-name>unterminated', 'command-name'), null);
});

test('extractTaggedContent treats the tag name as a literal, not a pattern', () => {
  // A regex-special tag name must not be compiled as a pattern: `a.c` should
  // not match `<abc>`, which is exactly what an unescaped `.` would allow.
  assert.equal(extractTaggedContent('<abc>value</abc>', 'a.c'), null);
  assert.equal(extractTaggedContent('<a.c>value</a.c>', 'a.c'), 'value');
});

test('extractTaggedContent stops at the first closing tag', () => {
  assert.equal(extractTaggedContent('<t>first</t><t>second</t>', 't'), 'first');
});

test('stripAnsiFormatting removes SGR sequences and leaves plain text alone', () => {
  assert.equal(stripAnsiFormatting(`${ESC}[32mhello${ESC}[0m world`), 'hello world');
  assert.equal(stripAnsiFormatting(`${ESC}[1;31mbold red${ESC}[m`), 'bold red');
  assert.equal(stripAnsiFormatting('already clean'), 'already clean');
});

test('parseClaudeLocalCommandPayload returns null when no command tag is present', () => {
  assert.equal(parseClaudeLocalCommandPayload('just a normal message'), null);
});

test('parseClaudeLocalCommandPayload fills absent tags with empty strings', () => {
  assert.deepEqual(
    parseClaudeLocalCommandPayload('<command-name>/goal</command-name>'),
    { commandName: '/goal', commandMessage: '', commandArgs: '' },
  );
});

test('parseClaudeLocalCommandPayload reads all three tags from one payload', () => {
  const content = '<command-name>/goal</command-name>'
    + '<command-message>goal</command-message>'
    + '<command-args>reduce code</command-args>';

  assert.deepEqual(parseClaudeLocalCommandPayload(content), {
    commandName: '/goal',
    commandMessage: 'goal',
    commandArgs: 'reduce code',
  });
});

test('buildClaudeLocalCommandDisplayText prefers the command name over the message', () => {
  assert.equal(
    buildClaudeLocalCommandDisplayText({ commandName: '/goal', commandMessage: 'goal', commandArgs: 'ship it' }),
    '/goal ship it',
  );
});

test('buildClaudeLocalCommandDisplayText falls back to the message when the name is blank', () => {
  assert.equal(
    buildClaudeLocalCommandDisplayText({ commandName: '  ', commandMessage: 'goal', commandArgs: '' }),
    'goal',
  );
});

test('buildClaudeLocalCommandDisplayText returns empty when there is no base command', () => {
  assert.equal(
    buildClaudeLocalCommandDisplayText({ commandName: '', commandMessage: '', commandArgs: 'orphan args' }),
    '',
  );
});

test('isVisibleCodexUserMessage accepts a plain, non-empty user message', () => {
  assert.equal(isVisibleCodexUserMessage({ type: 'user_message', message: 'hi' }), true);
  assert.equal(isVisibleCodexUserMessage({ type: 'user_message', kind: 'plain', message: 'hi' }), true);
});

test('isVisibleCodexUserMessage rejects harness-injected and empty turns', () => {
  assert.equal(isVisibleCodexUserMessage(null), false);
  assert.equal(isVisibleCodexUserMessage(undefined), false);
  assert.equal(isVisibleCodexUserMessage({ type: 'agent_reasoning', message: 'hi' }), false);
  assert.equal(isVisibleCodexUserMessage({ type: 'user_message', kind: 'environment_context', message: 'hi' }), false);
  assert.equal(isVisibleCodexUserMessage({ type: 'user_message', message: '   ' }), false);
  assert.equal(isVisibleCodexUserMessage({ type: 'user_message', message: 42 }), false);
});
