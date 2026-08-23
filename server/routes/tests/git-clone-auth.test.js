import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGitHubCloneEnvironment,
  redactGitHubUrlCredentials,
  validateGitHubCloneUrl,
} from '../git-clone-auth.js';

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

test('clone URLs reject embedded credentials and lookalike hosts', () => {
  assert.throws(
    () => validateGitHubCloneUrl('https://user:token@github.com/org/repo.git'),
    /Invalid GitHub URL/,
  );
  assert.throws(
    () => validateGitHubCloneUrl('https://github.com.attacker.invalid/org/repo.git'),
    /Invalid GitHub URL/,
  );
  assert.equal(validateGitHubCloneUrl('https://github.com/org/repo.git'), 'https://github.com/org/repo.git');
  assert.equal(validateGitHubCloneUrl('git@github.com:org/repo.git'), 'git@github.com:org/repo.git');
});

test('legacy credential-bearing remotes are redacted before display', () => {
  const redacted = redactGitHubUrlCredentials('https://user:secret@github.com/org/repo.git');
  assert.equal(redacted, 'https://github.com/org/repo.git');
  assert.equal(redacted.includes('secret'), false);
});
