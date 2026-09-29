import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateRowHeight, VIRTUAL_ROW_ESTIMATE_PX } from './rowHeightEstimate';
import type { ChatMessage } from '../types/types';
import type { ToolGroupItem } from './toolGrouping';

/*
 * cloudcli B2: the virtualizer positions every row from this estimate before
 * any of them have mounted and reported a real height. A flat guess is close
 * enough for a short message but leaves a long one's neighbours stacked on
 * top of each other for a frame; sizing off content length narrows that gap
 * for exactly the rows most likely to be tall.
 */

const message = (content: string): ChatMessage =>
  ({ type: 'assistant', content, timestamp: new Date().toISOString() }) as unknown as ChatMessage;

test('falls back to the flat estimate for an undefined row', () => {
  assert.equal(estimateRowHeight(undefined), VIRTUAL_ROW_ESTIMATE_PX);
});

test('falls back to the flat estimate when there is no string content', () => {
  assert.equal(estimateRowHeight(message('')), VIRTUAL_ROW_ESTIMATE_PX);
});

test('a short message stays at the flat estimate', () => {
  assert.equal(estimateRowHeight(message('looks good, thanks')), VIRTUAL_ROW_ESTIMATE_PX);
});

test('a longer message estimates taller than the flat guess', () => {
  const longContent = 'x'.repeat(600); // ~10 lines at 60 chars/line
  const estimate = estimateRowHeight(message(longContent));
  assert.ok(estimate > VIRTUAL_ROW_ESTIMATE_PX, `expected ${estimate} > ${VIRTUAL_ROW_ESTIMATE_PX}`);
});

test('the estimate is bounded so a huge paste cannot reserve unbounded space', () => {
  const hugeContent = 'x'.repeat(100_000);
  assert.equal(estimateRowHeight(message(hugeContent)), 640);
});

test('a tool group estimates off its first message', () => {
  const group: ToolGroupItem = {
    _isGroup: true,
    toolName: 'Read',
    timestamp: new Date().toISOString(),
    messages: [message('x'.repeat(600)), message('short')],
  };
  const estimate = estimateRowHeight(group);
  assert.ok(estimate > VIRTUAL_ROW_ESTIMATE_PX, `expected ${estimate} > ${VIRTUAL_ROW_ESTIMATE_PX}`);
});
