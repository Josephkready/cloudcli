import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, FormEvent, MouseEvent, MutableRefObject, SetStateAction, TouchEvent, KeyboardEvent } from 'react';

import { recordFeatureUse } from '../../../utils/featureUsage';
import {
  queuedMessageKey,
  readQueuedMessages,
  writeQueuedMessages,
  type QueuedSendOptions,
} from '../utils/chatStorage';
import { decideQueueFlush } from '../utils/queueFlush';
import { reconcileQueuedDraftsFromStorage, type QueuedDraft } from '../utils/queuedDrafts';
import type { ChatMessage } from '../types/types';

export type { QueuedDraft } from '../utils/queuedDrafts';

// In-memory-only id, used solely as a stable React key for queued cards. Not
// persisted (restored drafts get fresh ids); a monotonic counter is enough.
let queuedDraftSeq = 0;
const makeQueuedDraftId = () => `qd_${queuedDraftSeq++}`;

// A queued slash command that resolves to a *custom* (project-defined) command
// dispatches its real send asynchronously (after a `/api/commands/execute`
// round trip), so "no run started synchronously" isn't conclusive for
// command-like input. Hold this long before re-driving the drain, giving a
// started run time to flip `isLoading` so its completion edge takes over
// instead of the next item overtaking it. Built-ins (which start no run) just
// drain after the hold. A custom command slower than this could still race.
const COMMAND_REDRAIN_HOLD_MS = 1200;

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const restoreQueuedDrafts = (sessionKey: string): QueuedDraft[] =>
  // Image attachments can't survive a reload; only text and options persist.
  readQueuedMessages(sessionKey).map((saved) => ({
    id: makeQueuedDraftId(),
    content: saved.content,
    images: [],
    options: saved.options,
  }));

interface UseQueuedDraftsArgs {
  sessionKey: string | null;
  isLoading: boolean;
  setInput: Dispatch<SetStateAction<string>>;
  inputValueRef: MutableRefObject<string>;
  setAttachedImages: Dispatch<SetStateAction<File[]>>;
  addMessage: (msg: ChatMessage) => void;
  handleSubmitRef: MutableRefObject<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<boolean>) | null
  >;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
}

/**
 * Owns the queued-draft subsystem: the in-memory queue itself, persistence
 * to `queued_message_<id>`, cross-tab reconciliation (#459), the auto-drain
 * effect that replays the head through `handleSubmitRef` once a turn ends,
 * and the session-swap that swaps the queue when the viewed session changes.
 */
export function useQueuedDrafts({
  sessionKey,
  isLoading,
  setInput,
  inputValueRef,
  setAttachedImages,
  addMessage,
  handleSubmitRef,
  textareaRef,
}: UseQueuedDraftsArgs) {
  const [queuedDrafts, setQueuedDrafts] = useState<QueuedDraft[]>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return [];
    }
    return restoreQueuedDrafts(sessionKey);
  });
  // Latest queuedDrafts, for the cross-tab storage listener to read without
  // re-registering on every queue change (and so its reconcile runs outside the
  // setState updater, keeping that updater side-effect free).
  const queuedDraftsRef = useRef(queuedDrafts);
  queuedDraftsRef.current = queuedDrafts;
  // Which session the in-memory `queuedDrafts` belong to. On a session switch
  // there is one commit where `sessionKey` already points at the new session
  // while `queuedDrafts` still holds the old session's queue; the persistence
  // effect must not write across that gap.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);
  // Held in a ref so the queue-persistence effect can report a refused write
  // without depending on `addMessage` — an unmemoized caller would otherwise
  // make that effect re-run, and rewrite the queue, on every render.
  const addMessageRef = useRef(addMessage);
  useEffect(() => {
    addMessageRef.current = addMessage;
  }, [addMessage]);
  // Whether the persisted queue is a trustworthy mirror of `queuedDrafts`.
  // Goes false when storage refuses the write (#330), which is what tells the
  // drain below that an empty key means "never written" rather than "already
  // claimed by the other flusher".
  const queuePersistedRef = useRef(true);

  // Once the in-flight turn ends, replay the head of the queue through the
  // normal submit path (slash commands, image upload, etc. all still apply).
  const wasLoadingRef = useRef(isLoading);
  const flushSessionKeyRef = useRef(sessionKey);
  // True while a queued item's replay is in flight, so we never dispatch a
  // second queued message into the same window — the serialization guard that
  // also covers slow image uploads (which keep `isLoading` false for a while).
  const flushingRef = useRef(false);
  // Bumped to re-run the drain when a flushed item started no run (a built-in
  // command or a failed send), which produces no completion edge of its own.
  const [drainTick, setDrainTick] = useState(0);
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoading;

    // A session switch changes which session `isLoading` describes; the swap
    // effect below replaces `queuedDrafts` with the new session's saved queue
    // right after this. Track it so we never flush across the gap.
    const sessionChanged = flushSessionKeyRef.current !== sessionKey;
    if (sessionChanged) {
      flushSessionKeyRef.current = sessionKey;
    }

    const { flush, delayMs } = decideQueueFlush({
      sessionChanged,
      isLoading,
      isFlushing: flushingRef.current,
      queueLength: queuedDrafts.length,
      wasLoading,
    });
    if (!flush) {
      return;
    }

    const timer = setTimeout(() => {
      // The persisted queue is the claim ticket shared with the app-level
      // auto-send (which handles sessions that finish while not viewed). Re-read
      // it; if it's been drained elsewhere, just resync the in-memory queue.
      //
      // The exception is a queue storage refused to hold (#330): the key is
      // then empty because the write never landed, not because anyone claimed
      // it, and resyncing to it would silently drop the message the user was
      // just told would still be sent. Nothing else can have claimed it either
      // — the other flusher reads the same absent key — so replaying from the
      // in-memory copy cannot double-send.
      const persisted = sessionKey ? readQueuedMessages(sessionKey) : [];
      if (persisted.length === 0 && queuePersistedRef.current) {
        setQueuedDrafts([]);
        return;
      }
      const head = queuedDrafts[0];
      if (!head) {
        return;
      }
      // Claim the head by removing it from storage BEFORE replaying the send, so
      // a racing flusher can't also dispatch it; the tail stays queued.
      if (sessionKey) {
        writeQueuedMessages(sessionKey, persisted.slice(1));
      }
      // Latched before the state updates so any re-render this triggers sees the
      // flush as in progress and holds the next item.
      flushingRef.current = true;
      setQueuedDrafts((prev) => prev.slice(1));
      setInput(head.content);
      inputValueRef.current = head.content;
      setAttachedImages(head.images);
      // Defer a macrotask so the state above commits (and handleSubmit's closure
      // refreshes with the restored images) before we replay it.
      setTimeout(() => {
        void (async () => {
          let startedRun = false;
          try {
            startedRun = (await handleSubmitRef.current?.(createFakeSubmitEvent())) ?? false;
          } finally {
            flushingRef.current = false;
            // A real send starts a run whose completion edge drains the next
            // item. An item that starts no run (a built-in command, or a failed
            // send — including one that threw) produces no such edge, so nudge
            // the drain to keep going. Command-like input is held longer: a
            // custom command's real send is async, and the re-drive becomes a
            // no-op once that run flips isLoading (decideQueueFlush defers to the
            // completion edge). In `finally` so it still fires if the send threw.
            if (!startedRun) {
              const trimmed = head.content.trim();
              const wasCommandLike = trimmed.startsWith('/') || trimmed.toLowerCase() === 'help';
              const holdMs = wasCommandLike ? COMMAND_REDRAIN_HOLD_MS : 0;
              setTimeout(() => setDrainTick((tick) => tick + 1), holdMs);
            }
          }
        })();
      }, 0);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [isLoading, queuedDrafts, sessionKey, setInput, drainTick, inputValueRef, setAttachedImages, handleSubmitRef]);

  // Addressed by the draft's stable id (not array index) so an edit/delete can't
  // hit the wrong item if the queue shifts under it (e.g. the head drains).
  const editQueuedDraft = useCallback(
    (id: string) => {
      const target = queuedDrafts.find((draft) => draft.id === id);
      if (!target) {
        return;
      }
      // Pull the item out of the queue and back into the composer to edit.
      setQueuedDrafts((prev) => prev.filter((draft) => draft.id !== id));
      setInput(target.content);
      inputValueRef.current = target.content;
      setAttachedImages(target.images);
      textareaRef.current?.focus();
    },
    [queuedDrafts, setInput, inputValueRef, setAttachedImages, textareaRef],
  );

  const deleteQueuedDraft = useCallback((id: string) => {
    setQueuedDrafts((prev) => prev.filter((draft) => draft.id !== id));
  }, []);

  // Appends a message to the tail of the queue (not overwriting the existing
  // one), so multiple messages queue in order and each is auto-flushed once
  // the prior turn ends. Used by handleSubmit's "a turn is already in flight"
  // branch.
  const enqueueDraft = useCallback(
    (content: string, images: File[], options?: QueuedSendOptions) => {
      recordFeatureUse('chat.queue_message');
      queuedDraftSessionRef.current = sessionKey;
      setQueuedDrafts((prev) => [
        ...prev,
        { id: makeQueuedDraftId(), content, images, options },
      ]);
    },
    [sessionKey],
  );

  // Persist the queued messages under the session's key. Must be defined BEFORE
  // the swap effect below: on a session switch there is one commit where
  // `sessionKey` already points at the new session while `queuedDrafts` (and
  // the owner ref) still describe the old one — the ref mismatch makes this
  // effect skip that commit instead of writing/clearing across sessions.
  useEffect(() => {
    if (!sessionKey || queuedDraftSessionRef.current !== sessionKey) {
      return;
    }
    // writeQueuedMessages removes the key when the list is empty.
    const persisted = writeQueuedMessages(
      sessionKey,
      queuedDrafts.map((draft) => ({ content: draft.content, options: draft.options })),
    );
    queuePersistedRef.current = persisted;
    if (!persisted) {
      // Storage refused the queue, and quota recovery no longer buys room by
      // deleting it (#330), so this text now exists only in memory. Say so:
      // the whole point of the queue is that it survives a reload, and a user
      // who is told can copy the message out before losing it.
      addMessageRef.current({
        type: 'error',
        content:
          "This browser's storage is full, so your queued messages could not be saved. "
          + "They'll still be sent when the current response finishes, but they will be "
          + 'lost if you reload before then.',
        timestamp: new Date(),
      });
    }
  }, [queuedDrafts, sessionKey]);

  // Keep the viewed session's queue in sync with other tabs (#459). The queue
  // lives under one shared `queued_message_<id>` key, so a second tab on the same
  // session would otherwise blindly overwrite this tab's copy on its next persist
  // — losing a message queued here, or resurrecting one drained here. Adopting
  // the other tab's write means this tab's next persist reflects the shared state
  // instead of clobbering it. `storage` events fire only in OTHER documents, so
  // this never sees its own writes, and reconcile returns null (no state update)
  // when already in sync, which stops two synced tabs from ping-ponging.
  useEffect(() => {
    if (!sessionKey || typeof window === 'undefined') {
      return undefined;
    }
    const key = queuedMessageKey(sessionKey);
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== window.localStorage) {
        return;
      }
      // Only our session's queue key. A drain-to-empty in the other tab arrives
      // as this key with a null value (removeItem), which is handled. We
      // deliberately ignore a null key (another tab's storage.clear()): syncing
      // to empty on any unrelated clear would discard a message still being
      // composed here, and the in-memory queue self-heals on the next persist.
      if (event.key !== key) {
        return;
      }
      const stored = readQueuedMessages(sessionKey);
      const reconciled = reconcileQueuedDraftsFromStorage(queuedDraftsRef.current, stored, makeQueuedDraftId);
      if (reconciled) {
        setQueuedDrafts(reconciled);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [sessionKey]);

  // Switching sessions swaps in that session's queued messages (image
  // attachments can't survive a reload, so only text and options restore).
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDrafts([]);
      return;
    }
    setQueuedDrafts(restoreQueuedDrafts(sessionKey));
  }, [sessionKey]);

  return {
    queuedDrafts,
    enqueueDraft,
    editQueuedDraft,
    deleteQueuedDraft,
  };
}
