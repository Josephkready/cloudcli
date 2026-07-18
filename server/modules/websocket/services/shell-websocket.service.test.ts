import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { buildShellCommand, resolveResumeSessionId } from './shell-websocket.service.js';

// #69: the Shell tab must resume by the PROVIDER session id, not the app id.
// Claude only knows the provider id, so resuming by the app id fails ("no
// conversation found") and silently starts fresh. These pin the resolution.

const APP_ID = 'f37dc15b-5ae1-4423-988d-1718d918b68d';
const PROVIDER_ID = '87e6012b-1111-2222-3333-444455556666';

function deps(resolveProviderSessionId: (sessionId: string, provider: string) => string | null | undefined) {
  return {
    resolveProviderSessionId,
    stripAnsiSequences: (content: string) => content,
    normalizeDetectedUrl: () => null,
    extractUrlsFromText: () => [],
    shouldAutoOpenUrlFromOutput: () => false,
  };
}

const message = (over: Record<string, unknown> = {}) =>
  ({ hasSession: true, sessionId: APP_ID, provider: 'claude', ...over }) as never;

test('resolveResumeSessionId maps the app id to the provider id', () => {
  const d = deps((sessionId) => (sessionId === APP_ID ? PROVIDER_ID : null));
  assert.equal(resolveResumeSessionId(message(), d), PROVIDER_ID);
});

test('buildShellCommand resumes claude by the provider id', { skip: os.platform() === 'win32' }, () => {
  const d = deps(() => PROVIDER_ID);
  assert.equal(buildShellCommand(message(), d), `claude --resume "${PROVIDER_ID}" || claude`);
});

test('a throwing resolver falls back to the app id — the #69 failure mode', () => {
  // Documents why the missing sessionsDb import broke resume: the ReferenceError
  // is caught, resumeSessionId becomes undefined, and it falls back to the app
  // id, which `claude --resume` can't find. A working resolver returns the
  // provider id (test above).
  const d = deps(() => {
    throw new ReferenceError('sessionsDb is not defined');
  });
  assert.equal(resolveResumeSessionId(message(), d), APP_ID);
});

test('resolveResumeSessionId returns empty when there is no session to resume', () => {
  const d = deps(() => PROVIDER_ID);
  assert.equal(resolveResumeSessionId(message({ hasSession: false }), d), '');
  assert.equal(resolveResumeSessionId(message({ sessionId: '' }), d), '');
});

test('resolveResumeSessionId rejects an unsafe resolved id', () => {
  const d = deps(() => 'bad id; rm -rf /');
  assert.equal(resolveResumeSessionId(message(), d), '');
});
