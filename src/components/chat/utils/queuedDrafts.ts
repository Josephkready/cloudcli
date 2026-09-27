import type { QueuedSendOptions, StoredQueuedMessage } from './chatStorage';

export type QueuedDraft = {
  // Stable key for rendering the queue; never persisted.
  id: string;
  content: string;
  images: File[];
  /**
   * Send options snapshotted at queue time. Persisted with the draft so the
   * app-level auto-send can dispatch the message with the right model and
   * permission settings while another session is being viewed.
   */
  options?: QueuedSendOptions;
};

/**
 * Reconciles the in-memory queued drafts to what another tab wrote to storage
 * for the same session (#459). Two tabs on one session share the single
 * `queued_message_<id>` key, and the persistence effect writes this tab's
 * in-memory copy over it — so without adopting the other tab's writes, a stale
 * tab would clobber a message the other tab queued (loss) or resurrect one it
 * drained. Returns the new draft list, or `null` when the two already hold the
 * same messages in the same order, so the caller can skip the state update —
 * which is also what stops a cross-tab write from ping-ponging between two
 * already-synced tabs.
 *
 * Drafts are matched to stored messages by content, in order, so a surviving
 * message keeps its stable React id and any in-memory image attachments (which
 * never persist); a genuinely new message from the other tab gets a fresh id
 * and no images.
 */
export const reconcileQueuedDraftsFromStorage = (
  current: QueuedDraft[],
  stored: StoredQueuedMessage[],
  makeId: () => string,
): QueuedDraft[] | null => {
  const unchanged =
    current.length === stored.length
    && current.every((draft, index) => draft.content === stored[index]?.content);
  if (unchanged) {
    return null;
  }

  const reusableByContent = new Map<string, QueuedDraft[]>();
  for (const draft of current) {
    const bucket = reusableByContent.get(draft.content);
    if (bucket) {
      bucket.push(draft);
    } else {
      reusableByContent.set(draft.content, [draft]);
    }
  }
  // Storage carries no per-item id, so when another tab removes one of several
  // identical-content drafts we cannot tell WHICH survived. Reuse image-bearing
  // drafts first, so a surviving duplicate keeps its (non-persisted) attachment
  // rather than silently dropping it. Ids are ephemeral React keys, so which id
  // the survivor inherits does not matter.
  for (const bucket of reusableByContent.values()) {
    if (bucket.length > 1) {
      bucket.sort((a, b) => (b.images.length > 0 ? 1 : 0) - (a.images.length > 0 ? 1 : 0));
    }
  }

  return stored.map((message) => {
    const reused = reusableByContent.get(message.content)?.shift();
    return reused
      ? { ...reused, options: message.options }
      : { id: makeId(), content: message.content, images: [], options: message.options };
  });
};
