/** Which of the chat pane's mutually-exclusive top-level views to render. */
export type MessagesPaneView = 'loading' | 'error' | 'empty' | 'messages';

export interface MessagesPaneViewInput {
  /** The initial history fetch for this session is in flight. */
  isLoadingSessionMessages: boolean;
  /** A run is active, so messages are expected imminently. */
  isProcessing: boolean;
  /** How many messages are currently renderable. */
  messageCount: number;
  /** The last history load for this session failed. */
  loadFailed: boolean;
}

/**
 * Resolves the chat pane's view.
 *
 * Order matters, and two of the rules are load-bearing rather than cosmetic:
 *
 * - `messages` wins whenever there are any, so a failed *refresh* never blanks
 *   a thread the user is already reading.
 * - `error` outranks `empty`, because a failed load also leaves zero messages.
 *   Without that, a failure renders the "start a new conversation" empty state
 *   and looks exactly like the conversation was deleted.
 */
export function resolveMessagesPaneView(input: MessagesPaneViewInput): MessagesPaneView {
  const { isLoadingSessionMessages, isProcessing, messageCount, loadFailed } = input;

  if (messageCount > 0) {
    return 'messages';
  }

  if (isLoadingSessionMessages || isProcessing) {
    return 'loading';
  }

  if (loadFailed) {
    return 'error';
  }

  return 'empty';
}
