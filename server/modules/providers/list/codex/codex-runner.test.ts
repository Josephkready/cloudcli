import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCodexAbort } from './codex-runner.js';

test('Codex abort wiring aborts the controller and clears after settlement', () => {
  let installedAbort: (() => boolean) | null = null;
  let clears = 0;
  const writer = {
    setAbortHandler(handler: () => boolean) { installedAbort = handler; },
    clearAbortHandler() { clears += 1; },
  };
  const abortController = new AbortController();

  const clear = registerCodexAbort(writer, abortController);
  assert.equal((installedAbort as (() => boolean) | null)?.(), true);
  assert.equal(abortController.signal.aborted, true);
  clear();
  assert.equal(clears, 1);
});
