import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSelfUpdateDisabled,
  resolveInstallMode,
  resolveUpdatePlan,
} from '@/shared/self-update.js';

const APP_ROOT = '/home/jkready/prod/cloudcli';
const HOME_DIR = '/home/jkready';

test('isSelfUpdateDisabled is false when the env var is unset', () => {
  assert.equal(isSelfUpdateDisabled({}), false);
});

test('isSelfUpdateDisabled is true only for the exact string "true"', () => {
  assert.equal(isSelfUpdateDisabled({ SELF_UPDATE_DISABLED: 'true' }), true);
  // Anything else leaves self-update enabled, so a typo or a shell-quoted "True"
  // fails open to the historical behaviour rather than silently disabling the button.
  assert.equal(isSelfUpdateDisabled({ SELF_UPDATE_DISABLED: 'True' }), false);
  assert.equal(isSelfUpdateDisabled({ SELF_UPDATE_DISABLED: '1' }), false);
  assert.equal(isSelfUpdateDisabled({ SELF_UPDATE_DISABLED: 'false' }), false);
  assert.equal(isSelfUpdateDisabled({ SELF_UPDATE_DISABLED: '' }), false);
});

test('resolveInstallMode keys off the presence of a git checkout', () => {
  assert.equal(resolveInstallMode(true), 'git');
  assert.equal(resolveInstallMode(false), 'npm');
});

test('resolveUpdatePlan: platform mode runs its own script from the app root', () => {
  assert.deepEqual(
    resolveUpdatePlan({
      isPlatform: true,
      installMode: 'npm',
      appRoot: APP_ROOT,
      homeDir: HOME_DIR,
    }),
    { command: 'npm run update:platform', cwd: APP_ROOT },
  );
});

test('resolveUpdatePlan: platform mode wins over installMode', () => {
  // A platform deployment built from a checkout must still use the platform workflow,
  // cwd included — the git branch would otherwise pick the same appRoot by coincidence,
  // so assert the whole plan rather than just the command.
  assert.deepEqual(
    resolveUpdatePlan({
      isPlatform: true,
      installMode: 'git',
      appRoot: APP_ROOT,
      homeDir: HOME_DIR,
    }),
    { command: 'npm run update:platform', cwd: APP_ROOT },
  );
});

test('resolveUpdatePlan: a git checkout pulls in place from the app root', () => {
  assert.deepEqual(
    resolveUpdatePlan({
      isPlatform: false,
      installMode: 'git',
      appRoot: APP_ROOT,
      homeDir: HOME_DIR,
    }),
    { command: 'git checkout main && git pull && npm install', cwd: APP_ROOT },
  );
});

test('resolveUpdatePlan: an npm install reinstalls globally from the home dir', () => {
  assert.deepEqual(
    resolveUpdatePlan({
      isPlatform: false,
      installMode: 'npm',
      appRoot: APP_ROOT,
      homeDir: HOME_DIR,
    }),
    { command: 'npm install -g @cloudcli-ai/cloudcli@latest', cwd: HOME_DIR },
  );
});
