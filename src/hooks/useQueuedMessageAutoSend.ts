import { useEffect, useRef } from 'react';

import { readQueuedMessages, writeQueuedMessages } from '../components/chat/utils/chatStorage';

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
  sendMessage: (message: unknown) => void;
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
      writeQueuedMessages(sessionId, rest);
      sendMessage({
        type: 'chat.send',
        sessionId,
        content: head.content,
        options: { ...(head.options ?? {}), images: [] },
      });
      markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
    }
  }, [processingSessions, activeSessionId, ws, sendMessage, markSessionProcessing]);
}
