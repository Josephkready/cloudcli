import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_EXCLUDED_PROJECT_PATH_PATTERNS,
  compileGlobToRegex,
  getExcludedProjectPathPatterns,
  parseEnvExcludePatterns,
  shouldExcludeProjectPath,
} from '@/shared/project-exclude.js';

test('compileGlobToRegex: ** matches across path separators', () => {
  const regex = compileGlobToRegex('/tmp/**');
  assert.equal(regex.test('/tmp/foo'), true);
  assert.equal(regex.test('/tmp/foo/bar/baz'), true);
  assert.equal(regex.test('/var/tmp/foo'), false);
});

test('compileGlobToRegex: * does not match path separators', () => {
  const regex = compileGlobToRegex('/home/*/code');
  assert.equal(regex.test('/home/alice/code'), true);
  assert.equal(regex.test('/home/alice/bob/code'), false);
});

test('compileGlobToRegex: ? matches exactly one non-slash character', () => {
  const regex = compileGlobToRegex('/var/log?');
  assert.equal(regex.test('/var/logs'), true);
  assert.equal(regex.test('/var/log'), false);
  assert.equal(regex.test('/var/logss'), false);
});

test('compileGlobToRegex: regex metacharacters in literals are escaped', () => {
  const regex = compileGlobToRegex('/path.with(parens)/file+1');
  assert.equal(regex.test('/path.with(parens)/file+1'), true);
  assert.equal(regex.test('/pathXwith(parens)/file+1'), false);
});

test('parseEnvExcludePatterns: returns null when env var is undefined', () => {
  assert.equal(parseEnvExcludePatterns(undefined), null);
});

test('parseEnvExcludePatterns: empty string returns empty array', () => {
  assert.deepEqual(parseEnvExcludePatterns(''), []);
});

test('parseEnvExcludePatterns: splits on colon and trims whitespace', () => {
  assert.deepEqual(
    parseEnvExcludePatterns(' /tmp/** : **/build :  '),
    ['/tmp/**', '**/build'],
  );
});

test('getExcludedProjectPathPatterns: falls back to defaults when env unset', () => {
  const patterns = getExcludedProjectPathPatterns({});
  assert.deepEqual(patterns, [...DEFAULT_EXCLUDED_PROJECT_PATH_PATTERNS]);
});

test('getExcludedProjectPathPatterns: env var fully overrides defaults', () => {
  const patterns = getExcludedProjectPathPatterns({
    CLOUDCLI_EXCLUDED_PROJECT_PATHS: '/scratch/**:**/build',
  });
  assert.deepEqual(patterns, ['/scratch/**', '**/build']);
});

test('getExcludedProjectPathPatterns: empty env var disables all exclusions', () => {
  const patterns = getExcludedProjectPathPatterns({
    CLOUDCLI_EXCLUDED_PROJECT_PATHS: '',
  });
  assert.deepEqual(patterns, []);
});

test('shouldExcludeProjectPath: dante worktree under /tmp is excluded by defaults', () => {
  assert.equal(
    shouldExcludeProjectPath(
      '/tmp/myrepo-feature-abc12345',
      [...DEFAULT_EXCLUDED_PROJECT_PATH_PATTERNS],
    ),
    true,
  );
});

test('shouldExcludeProjectPath: in-repo worktrees/ subdir is excluded by defaults', () => {
  assert.equal(
    shouldExcludeProjectPath(
      '/home/jkready/repos/mytube/worktrees/agent-1234/workdir',
      [...DEFAULT_EXCLUDED_PROJECT_PATH_PATTERNS],
    ),
    true,
  );
});

test('shouldExcludeProjectPath: normal repo path is not excluded by defaults', () => {
  assert.equal(
    shouldExcludeProjectPath(
      '/home/jkready/repos/cheap-tokens',
      [...DEFAULT_EXCLUDED_PROJECT_PATH_PATTERNS],
    ),
    false,
  );
});

test('shouldExcludeProjectPath: empty patterns array never excludes', () => {
  assert.equal(shouldExcludeProjectPath('/tmp/anywhere', []), false);
});
