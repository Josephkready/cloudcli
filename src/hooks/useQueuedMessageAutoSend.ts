import { useEffect, useRef } from 'react';

import { readQueuedMessages, writeQueuedMessages } from '../components/chat/utils/chatStorage';
import {
  appendPendingSend,
  makePendingSendId,
  markPendingSendDispatched,
} from '../components/chat/utils/pendingSends';

import type { MarkSessionProcessing, SessionActivityMap } from './useSessionProtection';

interface UseQueuedMessageAutoSendArgs {
  processingSessions: SessionActivityMap;
  /**
   * The session currently open in the chat view. Its queued draft is owned by
   * the composer (which also handles image attachments and slash commands),
   * so this hook never touches it.
   */
  activeSessionId: string | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  markSessionProcessing: MarkSessionProcessing;
}

/**
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft (text + send options snapshotted at
 * queue time) under `queued_message_<sessionId>`. When a session's run leaves
 * the processing map — its previous response completed — this hook sends that
 * session's queued message immediately instead of waiting for the user to
 * open the session again. Removing the dispatched message from storage before
 * sending is the claim that keeps the composer's own flush from double-sending.
 * The queue is FIFO: one message is dispatched per completion and the rest stay
 * queued for subsequent completions.
 */
export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionId,
  ws,
  sendMessage,
  markSessionProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const prevProcessingRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const prev = prevProcessingRef.current;
    const current = new Set(processingSessions.keys());
    prevProcessingRef.current = current;

    for (const sessionId of prev) {
      if (current.has(sessionId) || sessionId === activeSessionId) {
        continue;
      }

      const queued = readQueuedMessages(sessionId);
      if (queued.length === 0) {
        continue;
      }

      // A closed socket would drop the send silently; keep the queue so the
      // composer (or a later completion) can retry once we're connected.
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      // Dispatch the head; persist the tail (the claim: remove before send) so
      // the next completion drains the following message, in order.
      const [head, ...rest] = queued;
      const sendOptions = { ...(head.options ?? {}), images: [] };

      // Give this auto-send the same durable, dedupable identity a composer send
      // has (#459). Without a clientMessageId the server cannot dedupe a resend
      // and never acks it (sendChatSendAccepted returns early on an empty id), so
      // a drained off-screen message had no delivery guarantee in either
      // direction. The pending record — written BEFORE the socket write, as the
      // composer does — is the only durable copy if the frame is lost on a
      // half-open socket, and it is what retryPendingSends resends on reconnect.
      const pendingSendId = makePendingSendId();
      appendPendingSend(sessionId, {
        id: pendingSendId,
        content: head.content,
        timestamp: new Date().toISOString(),
        options: sendOptions,
        dispatched: false,
      });

      // Durability-first ordering: the pending record is written above, then the
      // head is dropped from the queue (the claim that stops the composer's own
      // flush from double-sending). A hard crash in the gap between these two
      // writes leaves the message in both stores, which errs toward a duplicate
      // rather than the message loss the reverse order would risk.
      writeQueuedMessages(sessionId, rest);
      const dispatched = sendMessage({
        type: 'chat.send',
        sessionId,
        content: head.content,
        options: sendOptions,
        clientMessageId: pendingSendId,
      });

      // Only a socket that accepted the frame means a run started, so mirror the
      // composer: promote the pending record and flip the activity indicator only
      // then. A refused frame stays undelivered in the pending store (dispatched
      // false) and goes out on the next reconnect, without falsely showing the
      // session as processing.
      if (dispatched) {
        markPendingSendDispatched(sessionId, pendingSendId);
        markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
      }
    }
  }, [processingSessions, activeSessionId, ws, sendMessage, markSessionProcessing]);
}
