import { isToolGroupItem, type MessageListItem } from './toolGrouping';

/**
 * `ChatMessagesPane`'s row virtualizer needs a guess at each row's height
 * before it has ever mounted (and thus measured itself via
 * `measureElement`). A flat guess is fine for the common case, but a long
 * message can measure several times taller — and until it does, every row
 * below it is placed at the wrong offset, so the first-paint frame shows
 * rows stacked on top of each other before the (near-immediate) corrective
 * re-render lands (cloudcli B2). Sizing off the message's own content length
 * narrows that gap for exactly the rows most likely to be tall, without
 * needing a real DOM measurement.
 *
 * ~60 characters/line and ~20px/line are both rough (proportional fonts,
 * wrapped markdown, code blocks all vary), and deliberately so: this only
 * has to land within the same order of magnitude as the real height, same as
 * the flat guess it replaces.
 */
export const VIRTUAL_ROW_ESTIMATE_PX = 96;
const ESTIMATED_CHARS_PER_LINE = 60;
const ESTIMATED_PX_PER_LINE = 20;
const MAX_ESTIMATED_ROW_PX = 640;

export function estimateRowHeight(item: MessageListItem | undefined): number {
  if (!item) return VIRTUAL_ROW_ESTIMATE_PX;
  const message = isToolGroupItem(item) ? item.messages[0] : item;
  const content = message && typeof message.content === 'string' ? message.content : '';
  if (!content) return VIRTUAL_ROW_ESTIMATE_PX;
  const estimatedLines = Math.max(1, Math.ceil(content.length / ESTIMATED_CHARS_PER_LINE));
  return Math.min(
    MAX_ESTIMATED_ROW_PX,
    VIRTUAL_ROW_ESTIMATE_PX + (estimatedLines - 1) * ESTIMATED_PX_PER_LINE,
  );
}
