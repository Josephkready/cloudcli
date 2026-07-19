import assert from 'node:assert/strict';
import test from 'node:test';

import { FileFingerprintCache } from '@/modules/providers/list/claude/session-summary-cache.js';

test('returns undefined for a path that was never cached (miss)', () => {
  const cache = new FileFingerprintCache<string>();
  assert.equal(cache.get('/tmp/a.jsonl', { mtimeMs: 1, size: 1 }), undefined);
  assert.equal(cache.size, 0);
});

test('returns the cached value when the fingerprint matches exactly (hit)', () => {
  const cache = new FileFingerprintCache<string>();
  const fingerprint = { mtimeMs: 1000, size: 42 };
  cache.set('/tmp/a.jsonl', fingerprint, 'title-a');

  assert.equal(cache.get('/tmp/a.jsonl', { mtimeMs: 1000, size: 42 }), 'title-a');
  assert.equal(cache.size, 1);
});

test('a changed mtime busts the cache (miss)', () => {
  const cache = new FileFingerprintCache<string>();
  cache.set('/tmp/a.jsonl', { mtimeMs: 1000, size: 42 }, 'title-a');

  // Same size, newer mtime -> the file was rewritten, so the cached parse is stale.
  assert.equal(cache.get('/tmp/a.jsonl', { mtimeMs: 2000, size: 42 }), undefined);
});

test('a changed size busts the cache (miss)', () => {
  const cache = new FileFingerprintCache<string>();
  cache.set('/tmp/a.jsonl', { mtimeMs: 1000, size: 42 }, 'title-a');

  // Same mtime, larger size -> the file grew (appended), so re-read is required.
  assert.equal(cache.get('/tmp/a.jsonl', { mtimeMs: 1000, size: 99 }), undefined);
});

test('set replaces a stale entry with the new fingerprint and value', () => {
  const cache = new FileFingerprintCache<string>();
  cache.set('/tmp/a.jsonl', { mtimeMs: 1000, size: 42 }, 'old');
  cache.set('/tmp/a.jsonl', { mtimeMs: 2000, size: 50 }, 'new');

  assert.equal(cache.get('/tmp/a.jsonl', { mtimeMs: 2000, size: 50 }), 'new');
  assert.equal(cache.get('/tmp/a.jsonl', { mtimeMs: 1000, size: 42 }), undefined);
  assert.equal(cache.size, 1);
});

test('distinct paths are cached independently', () => {
  const cache = new FileFingerprintCache<string>();
  cache.set('/tmp/a.jsonl', { mtimeMs: 1, size: 1 }, 'a');
  cache.set('/tmp/b.jsonl', { mtimeMs: 1, size: 1 }, 'b');

  assert.equal(cache.get('/tmp/a.jsonl', { mtimeMs: 1, size: 1 }), 'a');
  assert.equal(cache.get('/tmp/b.jsonl', { mtimeMs: 1, size: 1 }), 'b');
  assert.equal(cache.size, 2);
});

test('an empty-object value is a valid cache hit (distinct from a miss)', () => {
  const cache = new FileFingerprintCache<Record<string, string>>();
  const empty: Record<string, string> = {};
  cache.set('/tmp/a.jsonl', { mtimeMs: 1, size: 1 }, empty);

  const hit = cache.get('/tmp/a.jsonl', { mtimeMs: 1, size: 1 });
  assert.deepEqual(hit, {});
  assert.notEqual(hit, undefined);
});

test('clear drops every entry', () => {
  const cache = new FileFingerprintCache<string>();
  cache.set('/tmp/a.jsonl', { mtimeMs: 1, size: 1 }, 'a');
  cache.clear();

  assert.equal(cache.size, 0);
  assert.equal(cache.get('/tmp/a.jsonl', { mtimeMs: 1, size: 1 }), undefined);
});
