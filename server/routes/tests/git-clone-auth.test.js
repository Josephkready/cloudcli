import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGitHubCloneEnvironment } from '../git-clone-auth.js';

test('GitHub clone credentials are process-scoped and do not alter the clone URL', () => {
  const token = 'ghp_plaintext-secret';
  const environment = buildGitHubCloneEnvironment(token, { PATH: '/usr/bin' });

  assert.equal(environment.GIT_CONFIG_COUNT, '1');
  assert.equal(environment.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader');
  assert.match(environment.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
  assert.equal(environment.GIT_CONFIG_VALUE_0.includes(token), false);
  assert.equal(environment.PATH, '/usr/bin');
});

test('anonymous clones do not install an authorization header', () => {
  const environment = buildGitHubCloneEnvironment(null, { PATH: '/usr/bin' });
  assert.equal(environment.GIT_CONFIG_COUNT, undefined);
  assert.equal(environment.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
});
