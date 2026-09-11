import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  prepareAttachments,
  sanitizeAttachmentName,
  sniffImageMime,
} from './bug-report-attachments.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('payload')]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('payload'),
]);
const GIF89 = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from('payload')]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('payload'),
]);

test('sniffImageMime reads content, not extension', () => {
  assert.equal(sniffImageMime(JPEG), 'image/jpeg');
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(GIF89), 'image/gif');
  assert.equal(sniffImageMime(WEBP), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('not an image')), null);
});

test('sniffImageMime never throws on a too-short buffer', () => {
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  assert.equal(sniffImageMime(Buffer.from([0xff])), null);
});

test('sanitizeAttachmentName strips path separators and traversal', () => {
  // path.basename already reduces this to the final segment; the point is
  // that no separator or ".." survives into the result either way.
  const out = sanitizeAttachmentName('../../etc/passwd');
  assert.ok(!out.includes('/'));
  assert.ok(!out.includes('..'));
});

test('sanitizeAttachmentName collapses internal dot runs', () => {
  assert.ok(!sanitizeAttachmentName('a..b.png').includes('..'));
  assert.ok(!sanitizeAttachmentName('foo..bar..baz.png').includes('..'));
});

test('sanitizeAttachmentName falls back on an empty/unsafe-only name', () => {
  assert.equal(sanitizeAttachmentName(''), 'screenshot');
  assert.equal(sanitizeAttachmentName('...'), 'screenshot');
});

test('sanitizeAttachmentName caps length', () => {
  const long = `${'x'.repeat(300)}.png`;
  assert.ok(sanitizeAttachmentName(long).length <= 150);
});

test('prepareAttachments returns the adapter shape for valid images', () => {
  const out = prepareAttachments([{ buffer: JPEG, originalname: 'Screenshot 1.jpg' }]);
  assert.deepEqual(out, [{ name: 'Screenshot-1.jpg', mime: 'image/jpeg', bytes: JPEG }]);
});

test('prepareAttachments accepts up to MAX_ATTACHMENTS in one call', () => {
  const uploads = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
    buffer: JPEG,
    originalname: `${i}.jpg`,
  }));
  assert.equal(prepareAttachments(uploads).length, MAX_ATTACHMENTS);
});

test('prepareAttachments rejects more than MAX_ATTACHMENTS with 413', () => {
  const uploads = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
    buffer: JPEG,
    originalname: `${i}.jpg`,
  }));
  assert.throws(
    () => prepareAttachments(uploads),
    (error: unknown) =>
      error instanceof AppError && error.statusCode === 413 && error.code === 'BUG_REPORT_ATTACHMENT_COUNT',
  );
});

test('prepareAttachments rejects an oversized image with 413', () => {
  const oversized = Buffer.concat([JPEG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
  assert.throws(
    () => prepareAttachments([{ buffer: oversized, originalname: 'big.jpg' }]),
    (error: unknown) => error instanceof AppError && error.statusCode === 413,
  );
});

test('prepareAttachments accepts exactly at the size cap', () => {
  const atCap = Buffer.concat([JPEG, Buffer.alloc(MAX_ATTACHMENT_BYTES - JPEG.length)]);
  assert.equal(atCap.length, MAX_ATTACHMENT_BYTES);
  const out = prepareAttachments([{ buffer: atCap, originalname: 'exact.jpg' }]);
  assert.equal(out[0].bytes.length, MAX_ATTACHMENT_BYTES);
});

test('prepareAttachments rejects empty and unrecognized content with 415', () => {
  assert.throws(
    () => prepareAttachments([{ buffer: Buffer.alloc(0), originalname: 'empty.jpg' }]),
    (error: unknown) => error instanceof AppError && error.statusCode === 415,
  );
  assert.throws(
    () => prepareAttachments([{ buffer: Buffer.from('not an image'), originalname: 'note.txt' }]),
    (error: unknown) => error instanceof AppError && error.statusCode === 415,
  );
});

test('prepareAttachments never trusts a mislabeled filename/extension', () => {
  // A .jpg extension around bytes that do not sniff as any allowed image type.
  assert.throws(
    () => prepareAttachments([{ buffer: Buffer.from('<html>not an image</html>'), originalname: 'shot.jpg' }]),
    (error: unknown) => error instanceof AppError && error.statusCode === 415,
  );
});

test('prepareAttachments with no uploads is an empty list', () => {
  assert.deepEqual(prepareAttachments([]), []);
});
