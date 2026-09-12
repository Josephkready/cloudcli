import { useTranslation } from 'react-i18next';
import { memo, useCallback, useMemo } from 'react';
import type { RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { ChatMessage } from '../../types/types';
import type {
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from '../../../../types/app';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import { resolveMessagesPaneView } from '../../utils/messagesPaneView';
import { groupConsecutiveTools, isToolGroupItem, type MessageListItem } from '../../utils/toolGrouping';

import MessageComponent from './MessageComponent';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';
import ToolGroupContainer from './ToolGroupContainer';
import LoadAllMessagesOverlay from './LoadAllMessagesOverlay';

// A row's real height is unknown until it mounts and reports itself via
// `measureElement` (markdown/Prism/Mermaid/images all vary a message's height
// wildly) — this is only the guess the virtualizer uses to decide the initial
// visible range before that measurement lands. It does not need to be
// accurate, only in the right order of magnitude so the first paint doesn't
// under- or over-render.
const VIRTUAL_ROW_ESTIMATE_PX = 96;
// Rendered a little beyond the viewport in each direction so a small scroll or
// a keyboard-driven scroll-into-view doesn't show a blank frame while the next
// row mounts.
const VIRTUAL_OVERSCAN = 8;

// A stable (module-level, never-changing) reference. `useVirtualizer` keys an
// internal measurement memo on this function's *identity*, not its return
// value (`@tanstack/virtual-core`'s `getMeasurementOptions`/`getMeasurements`
// memo chain, index.js ~592-720) — a fresh closure here on every render would
// invalidate that memo every render and force a full O(n) re-scan of every
// row's position on every scroll-driven re-render, exactly the cost this PR
// exists to remove. It takes no arguments that vary, so there is nothing to
// memoize away by hooking it; a plain top-level function is the stable
// reference.
function estimateVirtualRowSize(): number {
  return VIRTUAL_ROW_ESTIMATE_PX;
}

interface ChatMessagesPaneProps {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  sessionLoadFailed?: boolean;
  onRetryLoadSession?: () => void;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  antigravityModel: string;
  setAntigravityModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
}

function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  sessionLoadFailed = false,
  onRetryLoadSession,
  isProcessing = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  codexModel,
  setCodexModel,
  antigravityModel,
  setAntigravityModel,
  providerModelCatalog,
  providerModelsLoading,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const paneView = resolveMessagesPaneView({
    isLoadingSessionMessages,
    isProcessing,
    messageCount: chatMessages.length,
    loadFailed: sessionLoadFailed,
  });
  const groupedVisibleMessages = useMemo(
    () => groupConsecutiveTools(visibleMessages, Boolean(showThinking)),
    [visibleMessages, showThinking],
  );

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // `normalizedToChatMessages` only *sometimes* reuses a row's previous object
  // (a per-row cache hit) — a miss still mints a fresh one, and unevenly at
  // that — so caching keys by object identity (or via a cross-render allocation
  // Set) minted a brand-new key for the *same* logical message on each prepend —
  // remounting the whole list, which disconnects the scroll-restore anchor and
  // reflows heights, jumping the viewport to the bottom. Deriving keys purely
  // from this render's ordered messages (intrinsic key, disambiguated by
  // occurrence index on collision) yields the same key for the same message
  // order, so React preserves existing DOM nodes and component state on prepend.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  // Same key a row would get in the flat (`renderFlat`) render below —
  // shared so the virtualizer's internal measurement cache is keyed by the
  // same identity as everything else keys rows by, including across a prepend
  // (`getItemKey` is what lets react-virtual keep a row's already-measured
  // height when older messages are prepended and its index shifts).
  const getRowKey = useCallback(
    (item: MessageListItem) =>
      isToolGroupItem(item) ? `tool-group-${getMessageKey(item.messages[0])}` : getMessageKey(item),
    [getMessageKey],
  );

  // `prevMessage`/`groupPrevMessage` (grouping/avatar-continuity context) used
  // to come from a running variable threaded through one sequential `.map()`.
  // A virtualized list only renders a window of rows, not a contiguous prefix,
  // so a row's predecessor is looked up directly from the full (in-memory,
  // always-available regardless of what's mounted) `groupedVisibleMessages`
  // array instead.
  const prevMessageForRow = useCallback(
    (index: number): ChatMessage | null => {
      if (index <= 0) return null;
      const prevItem = groupedVisibleMessages[index - 1];
      return isToolGroupItem(prevItem) ? (prevItem.messages[prevItem.messages.length - 1] ?? null) : prevItem;
    },
    [groupedVisibleMessages],
  );

  const renderRow = useCallback(
    (item: MessageListItem, index: number) => {
      const prevMessage = prevMessageForRow(index);
      if (isToolGroupItem(item)) {
        return (
          <ToolGroupContainer
            key={getRowKey(item)}
            group={item}
            prevMessage={prevMessage}
            createDiff={createDiff}
            getMessageKey={getMessageKey}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onGrantToolPermission={onGrantToolPermission}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject}
            provider={provider}
          />
        );
      }

      return (
        <MessageComponent
          key={getRowKey(item)}
          message={item}
          prevMessage={prevMessage}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={onGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          provider={provider}
        />
      );
    },
    [
      prevMessageForRow,
      getRowKey,
      createDiff,
      getMessageKey,
      onFileOpen,
      onShowSettings,
      onGrantToolPermission,
      showRawParameters,
      showThinking,
      selectedProject,
      provider,
    ],
  );

  // Virtualized for every windowed view. Only an explicit "show the whole
  // thread" request — `visibleMessageCount === Infinity`, which is what "Load
  // all" and the in-conversation search-to-message jump both set — keeps the
  // flat, fully-mounted render below unchanged: the search flow finds its
  // target with a real DOM text/timestamp query over every message
  // (`useChatSessionState.ts`'s `searchTarget` effect), which depends on every
  // row actually being mounted. Scoping virtualization out of that one flow
  // avoids having to redesign it in this pass — see the PR description for the
  // tradeoff this leaves for a future phase.
  //
  // Deliberately NOT keyed on `allMessagesLoaded`: that flag also flips true
  // when incremental scroll-paging simply reaches the start of history
  // (`loadOlderMessages` → `!slot.hasMore`), while `visibleMessageCount` stays
  // finite. A reader who scrolled all the way back is exactly who has the most
  // rows loaded and benefits most from staying virtualized — and nothing in
  // that path needs every row in the DOM.
  const renderFlat = !Number.isFinite(visibleMessageCount);

  // `scrollContainerRef` itself never changes identity across renders (it's
  // the same ref object handed in by the parent), so this closure can be
  // memoized with no dependencies at all — same reasoning as
  // `estimateVirtualRowSize` above: a stable reference here keeps
  // `useVirtualizer`'s internal measurement memo from invalidating on every
  // render that isn't actually a scroll or resize.
  const getVirtualScrollElement = useCallback(
    () => scrollContainerRef.current,
    [scrollContainerRef],
  );

  // Unlike the two above, this one's dependencies are real: the key a row
  // gets genuinely must change when the underlying message list changes
  // (a new message, a reorder, a prepend). `useCallback` here means it ONLY
  // changes reference when `groupedVisibleMessages`/`getRowKey` actually did —
  // not on every incidental re-render (e.g. a scroll-driven one where the
  // data hasn't moved) — which is what keeps the memo chain above cheap on
  // the hot (scroll) path instead of defeating it the same way an inline
  // arrow here would.
  const getVirtualItemKey = useCallback(
    (index: number) => getRowKey(groupedVisibleMessages[index]),
    [getRowKey, groupedVisibleMessages],
  );

  const rowVirtualizer = useVirtualizer({
    count: renderFlat ? 0 : groupedVisibleMessages.length,
    getScrollElement: getVirtualScrollElement,
    estimateSize: estimateVirtualRowSize,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: getVirtualItemKey,
  });

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
    >
      {/* Vertical padding lives here, on the scrolled content, rather than on
          the scroll container above (cloudcli#475). A flex item's box-sizing
          can never resolve smaller than its own padding, so padding on the
          *container* put a floor (~24-56px, depending on breakpoint/activity
          indicator) under how far this pane could ever shrink — space a short
          (e.g. landscape phone) viewport with a keyboard up needs to hand to
          the composer instead. Padding on the *scrolled* content has no such
          effect: the container can still shrink to 0 while this div (and its
          padding) simply scrolls further out of view. */}
      <div className={`mx-auto w-full max-w-[54.25rem] space-y-3 px-4 pt-3 sm:space-y-4 sm:pt-4 ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}>
      {paneView === 'loading' ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : paneView === 'error' ? (
        // Distinct from the empty state on purpose: falling through to
        // "start a new conversation" after a failed load reads as though the
        // thread was deleted, which is the whole bug this guards against.
        <div className="mt-8 text-center">
          <p className="font-medium text-gray-700 dark:text-gray-200">
            {t('session.errors.loadFailedTitle')}
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">
            {t('session.errors.loadFailedBody')}
          </p>
          {onRetryLoadSession && (
            <button
              type="button"
              onClick={onRetryLoadSession}
              className="mt-4 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
            >
              {t('session.errors.loadFailedRetry')}
            </button>
          )}
        </div>
      ) : paneView === 'empty' ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          antigravityModel={antigravityModel}
          setAntigravityModel={setAntigravityModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-gray-500 dark:text-gray-400">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </div>
          )}

          <LoadAllMessagesOverlay
            showLoadAllOverlay={showLoadAllOverlay}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            totalMessages={totalMessages}
            onLoadAllMessages={loadAllMessages}
          />

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {renderFlat ? (
            groupedVisibleMessages.map((item, index) => renderRow(item, index))
          ) : (
            <div
              data-testid="virtual-row-viewport"
              style={{ position: 'relative', width: '100%', height: rowVirtualizer.getTotalSize() }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {/* Bakes the `space-y-3`/`space-y-4` inter-row gap into each
                      row instead of relying on adjacent-sibling margins, which
                      have no effect once rows are taken out of flow for
                      absolute positioning. */}
                  <div className="pb-3 sm:pb-4">
                    {renderRow(groupedVisibleMessages[virtualRow.index], virtualRow.index)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
