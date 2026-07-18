import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  languages,
  getLanguage,
  getLanguageValues,
  isLanguageSupported,
} from './languages.js';

// This fork is English-only. These tests lock in that the selectable language
// list never silently regains an entry that config.js has no `resources` block
// for — the class of bug that let `fr` be offered while falling back to English.

test('only English is offered', () => {
  assert.deepEqual(getLanguageValues(), ['en']);
  assert.equal(languages.length, 1);
});

type Language = { value: string; label: string; nativeName: string };

test('the English entry is well-formed', () => {
  const en = getLanguage('en') as Language | undefined;
  assert.ok(en, 'expected an English language entry');
  assert.equal(en?.value, 'en');
  assert.equal(en?.label, 'English');
  assert.equal(en?.nativeName, 'English');
});

test('English is supported; removed locales are not', () => {
  assert.equal(isLanguageSupported('en'), true);
  for (const removed of ['fr', 'de', 'ko', 'ja', 'ru', 'tr', 'it', 'zh-CN', 'zh-TW']) {
    assert.equal(isLanguageSupported(removed), false, `${removed} should no longer be supported`);
  }
});

test('getLanguage returns undefined for an unknown/removed code', () => {
  assert.equal(getLanguage('fr'), undefined);
  assert.equal(getLanguage('xx'), undefined);
});
