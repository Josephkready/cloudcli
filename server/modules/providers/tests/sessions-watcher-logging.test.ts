import assert from 'node:assert/strict';
import test from 'node:test';

import { logWatcherSync } from '@/modules/providers/services/sessions-watcher.service.js';

const TRANSCRIPT = '/home/u/.claude/projects/-repo/abc.jsonl';

test('watcher sync is silent by default (#536)', () => {
  const lines: unknown[][] = [];
  logWatcherSync('change', 'claude', TRANSCRIPT, 'app-1', {}, (...args) => lines.push(args));
  assert.equal(lines.length, 0);
});

test('CLOUDCLI_DEBUG_WATCHER=1 restores the per-change trace', () => {
  const lines: unknown[][] = [];
  logWatcherSync(
    'change',
    'antigravity',
    TRANSCRIPT,
    'app-2',
    { CLOUDCLI_DEBUG_WATCHER: '1' },
    (...args) => lines.push(args),
  );
  assert.deepEqual(lines, [[
    'Session synchronization triggered by change event for provider "antigravity"',
    { filePath: TRANSCRIPT, sessionId: 'app-2' },
  ]]);
});

test('any other value keeps it off', () => {
  const lines: unknown[][] = [];
  logWatcherSync('add', 'claude', TRANSCRIPT, 'app-3', { CLOUDCLI_DEBUG_WATCHER: 'true' }, (...args) => lines.push(args));
  assert.equal(lines.length, 0);
});
