import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PERMISSION_MODE_LABEL_KEYS, getPermissionModeLabelKeys } from './permissionModeLabels';

const chat = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../i18n/locales/en/chat.json'), 'utf8'),
) as Record<string, Record<string, Record<string, string>>>;

test('every permission mode has both a full and a short label key', () => {
  for (const [mode, keys] of Object.entries(PERMISSION_MODE_LABEL_KEYS)) {
    assert.ok(keys.full, `${mode} is missing a full label key`);
    assert.ok(keys.short, `${mode} is missing a short label key`);
  }
});

test('every label key resolves to a real string in the English bundle', () => {
  for (const [mode, keys] of Object.entries(PERMISSION_MODE_LABEL_KEYS)) {
    for (const key of [keys.full, keys.short]) {
      const [section, group, leaf] = key.split('.');
      const value = chat[section]?.[group]?.[leaf];
      assert.equal(typeof value, 'string', `${mode}: "${key}" is missing from chat.json`);
      assert.notEqual(value, '', `${mode}: "${key}" is empty`);
    }
  }
});

test('the short label is short enough to survive a phone-width pill', () => {
  for (const [mode, keys] of Object.entries(PERMISSION_MODE_LABEL_KEYS)) {
    const [section, group, leaf] = keys.short.split('.');
    const value = chat[section][group][leaf];
    assert.ok(value.length <= 8, `${mode}: short label "${value}" is too long for the pill`);
  }
});

test('an unrecognised mode still gets a labelled pill rather than an empty one', () => {
  const keys = getPermissionModeLabelKeys('something-the-server-invented');
  assert.deepEqual(keys, PERMISSION_MODE_LABEL_KEYS.default);
});

test('known modes map to their own keys', () => {
  assert.deepEqual(
    getPermissionModeLabelKeys('bypassPermissions'),
    PERMISSION_MODE_LABEL_KEYS.bypassPermissions,
  );
});
