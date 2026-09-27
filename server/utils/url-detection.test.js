import assert from 'node:assert/strict';
import test from 'node:test';

import {
  stripAnsiSequences,
  normalizeDetectedUrl,
  extractUrlsFromText,
  shouldAutoOpenUrlFromOutput,
} from './url-detection.js';

test('stripAnsiSequences removes escape codes and defaults to empty string', () => {
  assert.equal(stripAnsiSequences('\x1B[31mred\x1B[0m'), 'red');
  assert.equal(stripAnsiSequences(), '');
  assert.equal(stripAnsiSequences('plain text'), 'plain text');
});

test('normalizeDetectedUrl trims, strips trailing punctuation, and normalizes', () => {
  assert.equal(normalizeDetectedUrl('https://example.com/path).'), 'https://example.com/path');
  assert.equal(normalizeDetectedUrl('  https://example.com  '), 'https://example.com/');
});

test('normalizeDetectedUrl rejects non-http(s) protocols and invalid urls', () => {
  assert.equal(normalizeDetectedUrl('ftp://example.com'), null);
  assert.equal(normalizeDetectedUrl('not a url'), null);
  assert.equal(normalizeDetectedUrl(''), null);
  assert.equal(normalizeDetectedUrl(null), null);
  assert.equal(normalizeDetectedUrl(42), null);
});

test('normalizeDetectedUrl returns null when trimming/punctuation-stripping leaves nothing', () => {
  assert.equal(normalizeDetectedUrl('   ...   '), null);
});

test('extractUrlsFromText finds direct http(s) urls in plain text', () => {
  const text = 'Visit https://example.com/a and http://foo.bar/b for more info.';
  const urls = extractUrlsFromText(text);
  assert.ok(urls.includes('https://example.com/a'));
  assert.ok(urls.some((u) => u.startsWith('http://foo.bar/b')));
});

test('extractUrlsFromText defaults to empty string and returns no matches', () => {
  assert.deepEqual(extractUrlsFromText(), []);
  assert.deepEqual(extractUrlsFromText('no urls here'), []);
});

test('extractUrlsFromText stitches together a terminal-wrapped url across lines', () => {
  const text = 'Open this link:\nhttps://example.com/very/long/path\ncontinued-segment\n\nnext paragraph';
  const urls = extractUrlsFromText(text);
  assert.ok(urls.some((u) => u === 'https://example.com/very/long/pathcontinued-segment'));
});

test('extractUrlsFromText stops the wrap when a continuation line has disallowed characters', () => {
  const text = 'https://example.com/path\nthis has spaces so it stops';
  const urls = extractUrlsFromText(text);
  assert.ok(urls.includes('https://example.com/path'));
});

test('extractUrlsFromText dedupes identical direct and wrapped matches', () => {
  const text = 'https://example.com/a\nhttps://example.com/a';
  const urls = extractUrlsFromText(text);
  assert.equal(urls.filter((u) => u === 'https://example.com/a').length, 1);
});

test('shouldAutoOpenUrlFromOutput matches the documented trigger phrases case-insensitively', () => {
  assert.equal(shouldAutoOpenUrlFromOutput("Your browser didn't open?"), true);
  assert.equal(shouldAutoOpenUrlFromOutput('Please OPEN THIS URL manually'), true);
  assert.equal(shouldAutoOpenUrlFromOutput('continue in your browser now'), true);
  assert.equal(shouldAutoOpenUrlFromOutput('Press Enter to open the page'), true);
  assert.equal(shouldAutoOpenUrlFromOutput('open_url: https://example.com'), true);
  assert.equal(shouldAutoOpenUrlFromOutput('nothing relevant here'), false);
  assert.equal(shouldAutoOpenUrlFromOutput(), false);
});
