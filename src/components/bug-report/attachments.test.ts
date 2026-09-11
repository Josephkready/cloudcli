import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  canAcceptMore,
  extractImageEntries,
  makeId,
  privacyNotice,
  rejectionMessage,
  removeStaged,
  stageResult,
  targetDimensions,
  type StagedAttachment,
} from './attachments';

// ---- canAcceptMore / the count cap ----------------------------------------

test('canAcceptMore: room for more below the cap', () => {
  assert.equal(canAcceptMore([]), true);
  assert.equal(canAcceptMore([{}, {}]), true);
});

test('canAcceptMore: no room at or past the cap', () => {
  assert.equal(canAcceptMore([{}, {}, {}]), false);
  assert.equal(canAcceptMore([{}, {}, {}, {}]), false);
});

test('canAcceptMore: a missing list is treated as empty', () => {
  assert.equal(canAcceptMore(null), true);
  assert.equal(canAcceptMore(undefined), true);
});

// ---- targetDimensions: the long-edge downscale cap, never an upscale ------

test('targetDimensions: a source already under the cap is left alone', () => {
  assert.deepEqual(targetDimensions(800, 600), { width: 800, height: 600 });
  assert.deepEqual(targetDimensions(1600, 900), { width: 1600, height: 900 });
});

test('targetDimensions: a wide source is downscaled to a 1600px long edge', () => {
  const out = targetDimensions(3200, 1800);
  assert.equal(out.width, 1600);
  assert.equal(out.height, 900); // aspect ratio preserved
});

test('targetDimensions: a tall source downscales on its long (vertical) edge', () => {
  const out = targetDimensions(1200, 4800);
  assert.equal(out.height, 1600);
  assert.equal(out.width, 400);
});

test('targetDimensions: never upscales a small image', () => {
  assert.deepEqual(targetDimensions(200, 100), { width: 200, height: 100 });
});

test('targetDimensions: degenerate input still returns a usable positive size', () => {
  const out = targetDimensions(0, 0);
  assert.ok(out.width >= 1 && out.height >= 1);
});

// ---- extractImageEntries: paste/drop/file-picker item filtering -----------

test('extractImageEntries: pulls image files out of clipboardData.items via getAsFile', () => {
  const imageFile = { type: 'image/png', name: 'shot.png' };
  const clipboardData = {
    items: [
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', getAsFile: () => imageFile },
    ],
  };
  assert.deepEqual(extractImageEntries(clipboardData), [imageFile]);
});

test('extractImageEntries: a text-only paste yields nothing (and never throws)', () => {
  const clipboardData = { items: [{ kind: 'string', type: 'text/plain' }] };
  assert.deepEqual(extractImageEntries(clipboardData), []);
});

test('extractImageEntries: prefers .files over .items when both are present (no duplicates)', () => {
  const imageFile = { type: 'image/jpeg', name: 'a.jpg' };
  const source = {
    files: [imageFile],
    items: [{ kind: 'file', type: 'image/jpeg', getAsFile: () => imageFile }],
  };
  assert.deepEqual(extractImageEntries(source), [imageFile]);
});

test('extractImageEntries: falls back to .items when .files is empty', () => {
  const imageFile = { type: 'image/webp', name: 'b.webp' };
  const source = { files: [], items: [{ kind: 'file', type: 'image/webp', getAsFile: () => imageFile }] };
  assert.deepEqual(extractImageEntries(source), [imageFile]);
});

test('extractImageEntries: a bare FileList/array of Files works directly (the file-picker path)', () => {
  const files = [{ type: 'image/png', name: 'p.png' }, { type: 'text/plain', name: 'notes.txt' }];
  assert.deepEqual(extractImageEntries(files), [files[0]]);
});

test('extractImageEntries: non-image files in a drop are ignored, not staged', () => {
  const source = { files: [{ type: 'application/pdf', name: 'doc.pdf' }] };
  assert.deepEqual(extractImageEntries(source), []);
});

test('extractImageEntries: missing/empty source never throws', () => {
  assert.deepEqual(extractImageEntries(null), []);
  assert.deepEqual(extractImageEntries(undefined), []);
  assert.deepEqual(extractImageEntries({}), []);
});

// ---- stageResult: the count + size caps ------------------------------------

function entry(overrides: Partial<StagedAttachment> = {}) {
  return { name: 'shot.jpg', mime: 'image/jpeg', size: 1000, blob: {} as Blob, previewUrl: 'blob:x', ...overrides };
}

test('stageResult: a normal image is staged with a generated id', () => {
  const { list, rejected } = stageResult([], entry());
  assert.equal(rejected, null);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'shot.jpg');
  assert.ok(list[0].id);
});

test('stageResult: the count cap refuses a 4th image and leaves the list untouched', () => {
  const full = [entry({ id: '1' }), entry({ id: '2' }), entry({ id: '3' })] as StagedAttachment[];
  const { list, rejected } = stageResult(full, entry({ id: '4' }));
  assert.equal(rejected, 'too-many');
  assert.deepEqual(list, full);
  assert.equal(list.length, 3);
});

test('stageResult: an oversized (post-compression) blob is refused', () => {
  const { list, rejected } = stageResult([], entry({ size: MAX_ATTACHMENT_BYTES + 1 }));
  assert.equal(rejected, 'too-large');
  assert.deepEqual(list, []);
});

test('stageResult: exactly at the size cap is accepted (the cap is inclusive)', () => {
  const { rejected } = stageResult([], entry({ size: MAX_ATTACHMENT_BYTES }));
  assert.equal(rejected, null);
});

test('stageResult: the count cap is checked before the size cap', () => {
  const full = [entry({ id: '1' }), entry({ id: '2' }), entry({ id: '3' })] as StagedAttachment[];
  const { rejected } = stageResult(full, entry({ id: '4', size: MAX_ATTACHMENT_BYTES + 1 }));
  assert.equal(rejected, 'too-many');
});

test('stageResult: preserves a caller-supplied id instead of generating one', () => {
  const { list } = stageResult([], entry({ id: 'fixed-id' }));
  assert.equal(list[0].id, 'fixed-id');
});

test('stageResult: MAX_ATTACHMENTS is 3, matching the durable queue cap', () => {
  assert.equal(MAX_ATTACHMENTS, 3);
});

// ---- removeStaged: drops exactly one, leaves everything else alone --------

test('removeStaged: drops only the matching id', () => {
  const list = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })] as StagedAttachment[];
  const out = removeStaged(list, 'b');
  assert.deepEqual(out.map((item) => item.id), ['a', 'c']);
});

test('removeStaged: an id that is not present is a no-op', () => {
  const list = [entry({ id: 'a' })] as StagedAttachment[];
  assert.deepEqual(removeStaged(list, 'missing'), list);
});

test('removeStaged: a malformed list is treated as empty', () => {
  assert.deepEqual(removeStaged(null, 'a'), []);
});

// ---- privacy notice + rejection messages -----------------------------------

test('privacyNotice: names the risk (more than the auto-captured context)', () => {
  assert.match(privacyNotice(), /screen/i);
});

test('rejectionMessage: every known code has a human message; unknown codes are silent', () => {
  assert.match(rejectionMessage('too-many'), new RegExp(String(MAX_ATTACHMENTS)));
  assert.ok(rejectionMessage('too-large').length > 0);
  assert.ok(rejectionMessage('unsupported').length > 0);
  assert.equal(rejectionMessage('nonsense'), '');
});

// ---- makeId -----------------------------------------------------------------

test('makeId: produces a non-empty string starting with "a"', () => {
  const id = makeId();
  assert.equal(typeof id, 'string');
  assert.match(id, /^a[0-9a-z]+$/);
});

test('makeId: two calls produce different ids', () => {
  assert.notEqual(makeId(), makeId());
});

// ---- image-free path: nothing here should require an attachment -----------

test('a report with zero staged attachments is a normal empty list, not a special case', () => {
  assert.equal(canAcceptMore([]), true);
  assert.deepEqual(removeStaged([], 'anything'), []);
});
