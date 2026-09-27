import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileQueuedDraftsFromStorage, type QueuedDraft } from './queuedDrafts';

const draft = (id: string, content: string, images: File[] = []): QueuedDraft => ({ id, content, images });
let idSeq = 0;
const makeId = () => `new_${idSeq++}`;

test.beforeEach(() => {
  idSeq = 0;
});

test('returns null when in-memory and storage already match, so no state churn', () => {
  const current = [draft('a', 'one'), draft('b', 'two')];
  const stored = [{ content: 'one' }, { content: 'two' }];
  assert.equal(reconcileQueuedDraftsFromStorage(current, stored, makeId), null);
});

test('adopts a message another tab appended, preserving existing ids by content', () => {
  const current = [draft('a', 'one')];
  const stored = [{ content: 'one' }, { content: 'two', options: { model: 'x' } }];

  const result = reconcileQueuedDraftsFromStorage(current, stored, makeId);

  assert.notEqual(result, null);
  assert.deepEqual(result?.map((d) => d.content), ['one', 'two']);
  assert.equal(result?.[0].id, 'a'); // survivor keeps its stable React id
  assert.equal(result?.[1].id, 'new_0'); // the new item gets a fresh id
  assert.deepEqual(result?.[1].options, { model: 'x' });
});

test('adopts a drain another tab made (message removed from storage)', () => {
  const current = [draft('a', 'one'), draft('b', 'two')];
  const stored = [{ content: 'two' }];

  const result = reconcileQueuedDraftsFromStorage(current, stored, makeId);

  assert.deepEqual(result?.map((d) => d.content), ['two']);
  assert.equal(result?.[0].id, 'b'); // the surviving draft keeps its id
});

test('preserves in-memory image attachments for a surviving message', () => {
  const image = new File(['x'], 'x.png', { type: 'image/png' });
  const current: QueuedDraft[] = [{ id: 'a', content: 'one', images: [image] }];
  const stored = [{ content: 'one' }, { content: 'two' }];

  const result = reconcileQueuedDraftsFromStorage(current, stored, makeId);

  assert.deepEqual(result?.[0].images, [image]); // images never persist, kept from memory
  assert.deepEqual(result?.[1].images, []);
});

test('keeps the image-bearing survivor when a duplicate-content draft is removed', () => {
  // Storage carries no id, so which of two identical "foo" drafts the other tab
  // removed is ambiguous; the surviving one must keep its attachment, not drop it.
  const image = new File(['x'], 'x.png', { type: 'image/png' });
  const current: QueuedDraft[] = [
    { id: 'a', content: 'foo', images: [] },
    { id: 'c', content: 'foo', images: [image] },
  ];
  const stored = [{ content: 'foo' }];

  const result = reconcileQueuedDraftsFromStorage(current, stored, makeId);

  assert.deepEqual(result?.map((d) => d.content), ['foo']);
  assert.deepEqual(result?.[0].images, [image]); // the attachment survives
});
