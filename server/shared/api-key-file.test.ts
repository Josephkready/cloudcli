import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readKeyFromContents, readKeyFromFile } from './api-key-file.js';

test('reads the named key and ignores every other line in the file', () => {
  const contents = [
    'UNRELATED_SECRET=do-not-leak',
    'VOICE_STT_API_KEY=gsk_wanted',
    'ANOTHER_SECRET=also-do-not-leak',
  ].join('\n');
  assert.equal(readKeyFromContents(contents, ['VOICE_STT_API_KEY']), 'gsk_wanted');
});

test('names are tried in priority order, not file order', () => {
  const contents = 'GROQ_API_KEY=second\nVOICE_STT_API_KEY=first';
  assert.equal(readKeyFromContents(contents, ['VOICE_STT_API_KEY', 'GROQ_API_KEY']), 'first');
  assert.equal(readKeyFromContents(contents, ['GROQ_API_KEY', 'VOICE_STT_API_KEY']), 'second');
});

test('tolerates export prefixes and quoting', () => {
  assert.equal(readKeyFromContents('export VOICE_STT_API_KEY=k1', ['VOICE_STT_API_KEY']), 'k1');
  assert.equal(readKeyFromContents('VOICE_STT_API_KEY="k2"', ['VOICE_STT_API_KEY']), 'k2');
  assert.equal(readKeyFromContents("VOICE_STT_API_KEY='k3'", ['VOICE_STT_API_KEY']), 'k3');
  assert.equal(readKeyFromContents('  VOICE_STT_API_KEY = k4', ['VOICE_STT_API_KEY']), '');
});

test('a name that only prefixes another is not matched', () => {
  // VOICE_STT_API_KEY_FILE must not satisfy a lookup for VOICE_STT_API_KEY.
  const contents = 'VOICE_STT_API_KEY_FILE=/some/path';
  assert.equal(readKeyFromContents(contents, ['VOICE_STT_API_KEY']), '');
});

test('empty and absent values both yield the empty string', () => {
  assert.equal(readKeyFromContents('VOICE_STT_API_KEY=', ['VOICE_STT_API_KEY']), '');
  assert.equal(readKeyFromContents('NOTHING=here', ['VOICE_STT_API_KEY']), '');
  assert.equal(readKeyFromContents('', ['VOICE_STT_API_KEY']), '');
});

test('reads from a real file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keyfile-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'VOICE_STT_API_KEY=from-disk\n');
  assert.equal(readKeyFromFile(file, ['VOICE_STT_API_KEY'], 'voice'), 'from-disk');
});

test('an unreadable file degrades to empty rather than throwing', () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    const missing = join(tmpdir(), 'definitely-not-here-9e3f', '.env');
    assert.equal(readKeyFromFile(missing, ['VOICE_STT_API_KEY'], 'voice'), '');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[voice\] Could not read /);
  } finally {
    console.warn = original;
  }
});
