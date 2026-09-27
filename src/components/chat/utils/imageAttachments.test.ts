import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_IMAGE_ATTACHMENT_BYTES, partitionImageFiles } from './imageAttachments';

const file = (overrides: Partial<{ type: string; size: number; name: string }> = {}) => ({
  type: 'image/png',
  size: 1024,
  name: 'a.png',
  ...overrides,
});

test('accepts an image under the size ceiling', () => {
  const result = partitionImageFiles([file()]);
  assert.equal(result.validFiles.length, 1);
  assert.deepEqual(result.errors, []);
});

test('rejects a non-image type silently (no error entry)', () => {
  const result = partitionImageFiles([file({ type: 'text/plain' })]);
  assert.equal(result.validFiles.length, 0);
  assert.deepEqual(result.errors, []);
});

test('rejects an oversized image with a named error', () => {
  const result = partitionImageFiles([file({ size: MAX_IMAGE_ATTACHMENT_BYTES + 1, name: 'big.png' })]);
  assert.equal(result.validFiles.length, 0);
  assert.deepEqual(result.errors, [{ fileName: 'big.png', message: 'File too large (max 5MB)' }]);
});

test('a zero-byte file is rejected the same as oversized (falsy size check)', () => {
  const result = partitionImageFiles([file({ size: 0 })]);
  assert.equal(result.validFiles.length, 0);
  assert.equal(result.errors.length, 1);
});

test('falls back to "Unknown file" when the oversized file has no name', () => {
  const result = partitionImageFiles([file({ size: MAX_IMAGE_ATTACHMENT_BYTES + 1, name: '' })]);
  assert.equal(result.errors[0]?.fileName, 'Unknown file');
});

test('skips null/non-object entries without throwing', () => {
  const result = partitionImageFiles([null as unknown as ReturnType<typeof file>, file()]);
  assert.equal(result.validFiles.length, 1);
  assert.deepEqual(result.errors, []);
});

test('partitions a mixed batch in order', () => {
  const good = file({ name: 'good.png' });
  const bad = file({ name: 'bad.png', size: MAX_IMAGE_ATTACHMENT_BYTES + 1 });
  const result = partitionImageFiles([good, bad]);
  assert.equal(result.validFiles.length, 1);
  assert.equal(result.validFiles[0]?.name, 'good.png');
  assert.equal(result.errors[0]?.fileName, 'bad.png');
});
