import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCodexAbort } from './openai-codex.js';

test('Codex abort wiring aborts the controller and clears after settlement', () => {
  let installedAbort = null;
  let clears = 0;
  const writer = {
    setAbortHandler(handler) { installedAbort = handler; },
    clearAbortHandler() { clears += 1; },
  };
  const abortController = new AbortController();

  const clear = registerCodexAbort(writer, abortController);
  assert.equal(installedAbort(), true);
  assert.equal(abortController.signal.aborted, true);
  clear();
  assert.equal(clears, 1);
});
