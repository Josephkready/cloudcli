import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import {
  buildClaudeToolPermissionEntry,
  formatToolInputForDisplay,
  getClaudePermissionSuggestion,
  grantClaudeToolPermission,
} from './chatPermissions';

/**
 * Install a minimal in-memory `localStorage` for the duration of `fn`, then
 * restore the previous global exactly (delete it if it wasn't there). The two
 * settings-backed functions read/write `localStorage` via `safeLocalStorage`;
 * everything else in this module is pure.
 */
function withLocalStorage<T>(seed: Record<string, string>, fn: (store: Map<string, string>) => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const prev = g.localStorage;
  const store = new Map<string, string>(Object.entries(seed));
  g.localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string): void => { store.set(k, v); },
    removeItem: (k: string): void => { store.delete(k); },
  };
  try {
    return fn(store);
  } finally {
    if (had) g.localStorage = prev;
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

const CLAUDE_SETTINGS_KEY = 'claude-settings';

const toolMessage = (over: Partial<ChatMessage>): ChatMessage => ({
  type: 'assistant',
  timestamp: 0,
  isToolUse: true,
  toolResult: { isError: true },
  ...over,
});

/* ── buildClaudeToolPermissionEntry: Bash command → allow-rule ───────────── */

test('buildClaudeToolPermissionEntry: no tool name yields null', () => {
  assert.equal(buildClaudeToolPermissionEntry(undefined), null);
  assert.equal(buildClaudeToolPermissionEntry(''), null);
});

test('buildClaudeToolPermissionEntry: a non-Bash tool maps to its own name', () => {
  assert.equal(buildClaudeToolPermissionEntry('Read'), 'Read');
  assert.equal(buildClaudeToolPermissionEntry('Edit', '{"command":"ignored"}'), 'Edit');
});

test('buildClaudeToolPermissionEntry: git commands keep the subcommand in the rule', () => {
  assert.equal(
    buildClaudeToolPermissionEntry('Bash', '{"command":"git commit -m x"}'),
    'Bash(git commit:*)',
  );
  assert.equal(
    buildClaudeToolPermissionEntry('Bash', '{"command":"  git   push  origin"}'),
    'Bash(git push:*)',
  );
});

test('buildClaudeToolPermissionEntry: a bare `git` with no subcommand rules on git alone', () => {
  assert.equal(buildClaudeToolPermissionEntry('Bash', '{"command":"git"}'), 'Bash(git:*)');
});

test('buildClaudeToolPermissionEntry: non-git commands rule on the first token', () => {
  assert.equal(buildClaudeToolPermissionEntry('Bash', '{"command":"npm install foo"}'), 'Bash(npm:*)');
  assert.equal(buildClaudeToolPermissionEntry('Bash', '{"command":"ls -la"}'), 'Bash(ls:*)');
});

test('buildClaudeToolPermissionEntry: empty / missing / non-string input falls back to `Bash`', () => {
  assert.equal(buildClaudeToolPermissionEntry('Bash', '{"command":"   "}'), 'Bash');
  assert.equal(buildClaudeToolPermissionEntry('Bash', undefined), 'Bash');
  assert.equal(buildClaudeToolPermissionEntry('Bash', 'not json'), 'Bash');
  // safeJsonParse only accepts strings — an already-parsed object yields no command.
  assert.equal(buildClaudeToolPermissionEntry('Bash', { command: 'git commit' }), 'Bash');
});

/* ── formatToolInputForDisplay ───────────────────────────────────────────── */

test('formatToolInputForDisplay: nullish input renders as an empty string', () => {
  assert.equal(formatToolInputForDisplay(undefined), '');
  assert.equal(formatToolInputForDisplay(null), '');
});

test('formatToolInputForDisplay: a string is passed through verbatim', () => {
  assert.equal(formatToolInputForDisplay('echo hi'), 'echo hi');
});

test('formatToolInputForDisplay: objects are pretty-printed as JSON', () => {
  assert.equal(formatToolInputForDisplay({ a: 1, b: 'x' }), '{\n  "a": 1,\n  "b": "x"\n}');
});

test('formatToolInputForDisplay: an unstringifiable value falls back to String()', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(formatToolInputForDisplay(circular), '[object Object]');
});

/* ── getClaudePermissionSuggestion ───────────────────────────────────────── */

test('getClaudePermissionSuggestion: non-claude providers get no suggestion', () => {
  const message = toolMessage({ toolName: 'Bash', toolInput: '{"command":"git commit"}' });
  assert.equal(getClaudePermissionSuggestion(message, 'codex'), null);
});

test('getClaudePermissionSuggestion: non-error results get no suggestion', () => {
  const message = toolMessage({
    toolName: 'Bash',
    toolInput: '{"command":"git commit"}',
    toolResult: { isError: false },
  });
  assert.equal(getClaudePermissionSuggestion(message, 'claude'), null);
});

test('getClaudePermissionSuggestion: a null/undefined message yields no suggestion', () => {
  assert.equal(getClaudePermissionSuggestion(null, 'claude'), null);
  assert.equal(getClaudePermissionSuggestion(undefined, 'claude'), null);
});

test('getClaudePermissionSuggestion: a tool-less error yields no entry, no suggestion', () => {
  const message = toolMessage({ toolName: undefined });
  assert.equal(getClaudePermissionSuggestion(message, 'claude'), null);
});

test('getClaudePermissionSuggestion: an unallowed failing Bash command is suggested (isAllowed=false)', () => {
  withLocalStorage({}, () => {
    const message = toolMessage({ toolName: 'Bash', toolInput: '{"command":"git commit -m x"}' });
    assert.deepEqual(getClaudePermissionSuggestion(message, 'claude'), {
      toolName: 'Bash',
      entry: 'Bash(git commit:*)',
      isAllowed: false,
    });
  });
});

test('getClaudePermissionSuggestion: reflects an already-allowed rule (isAllowed=true)', () => {
  const seed = { [CLAUDE_SETTINGS_KEY]: JSON.stringify({ allowedTools: ['Bash(git commit:*)'] }) };
  withLocalStorage(seed, () => {
    const message = toolMessage({ toolName: 'Bash', toolInput: '{"command":"git commit -m x"}' });
    assert.deepEqual(getClaudePermissionSuggestion(message, 'claude'), {
      toolName: 'Bash',
      entry: 'Bash(git commit:*)',
      isAllowed: true,
    });
  });
});

/* ── grantClaudeToolPermission ───────────────────────────────────────────── */

test('grantClaudeToolPermission: a null entry is a no-op failure', () => {
  assert.deepEqual(grantClaudeToolPermission(null), { success: false });
});

test('grantClaudeToolPermission: a new entry is appended and persisted', () => {
  withLocalStorage({}, (store) => {
    const result = grantClaudeToolPermission('Bash(git commit:*)');
    assert.equal(result.success, true);
    assert.equal(result.alreadyAllowed, false);
    assert.ok(result.updatedSettings?.allowedTools.includes('Bash(git commit:*)'));
    // Persisted to storage, not just returned.
    const persisted = JSON.parse(store.get(CLAUDE_SETTINGS_KEY) as string);
    assert.ok(persisted.allowedTools.includes('Bash(git commit:*)'));
  });
});

test('grantClaudeToolPermission: granting an already-allowed entry does not duplicate it', () => {
  const seed = { [CLAUDE_SETTINGS_KEY]: JSON.stringify({ allowedTools: ['Bash(npm:*)'] }) };
  withLocalStorage(seed, () => {
    const result = grantClaudeToolPermission('Bash(npm:*)');
    assert.equal(result.alreadyAllowed, true);
    assert.deepEqual(result.updatedSettings?.allowedTools, ['Bash(npm:*)']);
  });
});

test('grantClaudeToolPermission: granting moves an entry out of the disallowed list', () => {
  const seed = {
    [CLAUDE_SETTINGS_KEY]: JSON.stringify({ allowedTools: [], disallowedTools: ['Bash(rm:*)'] }),
  };
  withLocalStorage(seed, () => {
    const result = grantClaudeToolPermission('Bash(rm:*)');
    assert.ok(result.updatedSettings?.allowedTools.includes('Bash(rm:*)'));
    assert.ok(!result.updatedSettings?.disallowedTools.includes('Bash(rm:*)'));
  });
});
