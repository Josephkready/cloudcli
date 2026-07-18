import assert from 'node:assert/strict';
import test from 'node:test';

import { isBinaryFile } from './binaryFile';

/* ── isBinaryFile ────────────────────────────────────────────────────────── */

test('isBinaryFile: recognizes archives, executables, docs, fonts and databases', () => {
  assert.equal(isBinaryFile('bundle.zip'), true);
  assert.equal(isBinaryFile('app.exe'), true);
  assert.equal(isBinaryFile('report.pdf'), true);
  assert.equal(isBinaryFile('font.woff2'), true);
  assert.equal(isBinaryFile('data.sqlite3'), true);
});

test('isBinaryFile: extension check is case-insensitive', () => {
  assert.equal(isBinaryFile('ARCHIVE.ZIP'), true);
  assert.equal(isBinaryFile('Doc.PDF'), true);
});

test('isBinaryFile: only the final extension counts', () => {
  assert.equal(isBinaryFile('backup.zip.txt'), false);
  assert.equal(isBinaryFile('backup.txt.zip'), true);
});

test('isBinaryFile: text and image files are not treated as binary', () => {
  // Images are handled by ImageViewer, so they are deliberately excluded here.
  assert.equal(isBinaryFile('index.ts'), false);
  assert.equal(isBinaryFile('photo.png'), false);
  assert.equal(isBinaryFile('notes.md'), false);
});

test('isBinaryFile: a name with no extension is not binary', () => {
  assert.equal(isBinaryFile('Makefile'), false);
  assert.equal(isBinaryFile('LICENSE'), false);
});
