import assert from 'node:assert/strict';
import test from 'node:test';

import { getPreviewKind, getPreviewMimeType } from './previewableFile';

/* ── getPreviewKind ──────────────────────────────────────────────────────── */

test('getPreviewKind: maps each media family to its preview kind', () => {
  assert.equal(getPreviewKind('photo.png'), 'image');
  assert.equal(getPreviewKind('vector.svg'), 'image');
  assert.equal(getPreviewKind('doc.pdf'), 'pdf');
  assert.equal(getPreviewKind('clip.mp4'), 'video');
  assert.equal(getPreviewKind('song.mp3'), 'audio');
});

test('getPreviewKind: extension match is case-insensitive', () => {
  assert.equal(getPreviewKind('PHOTO.PNG'), 'image');
  assert.equal(getPreviewKind('Clip.MOV'), 'video');
});

test('getPreviewKind: browser-unplayable and non-media extensions are not previewable', () => {
  // avi/mkv/flv/wmv are intentionally excluded so they keep the binary fallback.
  assert.equal(getPreviewKind('movie.avi'), null);
  assert.equal(getPreviewKind('movie.mkv'), null);
  assert.equal(getPreviewKind('archive.zip'), null);
  assert.equal(getPreviewKind('README'), null);
  assert.equal(getPreviewKind('noext.'), null);
});

/* ── getPreviewMimeType ──────────────────────────────────────────────────── */

test('getPreviewMimeType: returns the fallback MIME for previewable extensions', () => {
  assert.equal(getPreviewMimeType('a.jpg'), 'image/jpeg');
  assert.equal(getPreviewMimeType('a.jpeg'), 'image/jpeg');
  assert.equal(getPreviewMimeType('a.pdf'), 'application/pdf');
  assert.equal(getPreviewMimeType('a.webm'), 'video/webm');
});

test('getPreviewMimeType: returns undefined for non-previewable extensions', () => {
  assert.equal(getPreviewMimeType('a.zip'), undefined);
  assert.equal(getPreviewMimeType('a'), undefined);
});

test('getPreviewKind and getPreviewMimeType stay consistent for the same extension', () => {
  // The kind is derived from the MIME map, so a MIME implies a non-null kind.
  for (const name of ['a.png', 'a.pdf', 'a.mp4', 'a.flac']) {
    const mime = getPreviewMimeType(name);
    const kind = getPreviewKind(name);
    assert.ok(mime, `${name} should have a MIME`);
    assert.ok(kind, `${name} should have a preview kind`);
  }
});
