import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { recordFeatureUse } from '../../../utils/featureUsage';
import { SHARED_TEXT_KEY } from '../../../pwa/launchParams';
import type { MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import { safeLocalStorage, type QueuedSendOptions } from '../utils/chatStorage';
import { appendPendingSend, makePendingSendId, markPendingSendDispatched } from '../utils/pendingSends';
import { resolveEnterKeyAction } from '../utils/enterKeyAction';
import { getNotificationSessionSummary } from '../utils/sessionSummary';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';

import { useFileMentions } from './useFileMentions';
import { type SlashCommand, useSlashCommands } from './useSlashCommands';
import { useComposerCommands } from './useComposerCommands';
import { useComposerImageAttachments } from './useComposerImageAttachments';
import { useComposerTextarea } from './useComposerTextarea';
import { useComposerPermissions } from './useComposerPermissions';
import { useQueuedDrafts } from './useQueuedDrafts';

export type {
  ModelCommandData,
  CostCommandData,
  StatusCommandData,
  HelpCommandData,
  CommandModalKind,
  CommandModalPayload,
} from './useComposerCommands';
export type { QueuedDraft } from './useQueuedDrafts';
export { reconcileQueuedDraftsFromStorage } from '../utils/queuedDrafts';

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  claudeModel: string;
  codexModel: string;
  antigravityModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => boolean;
  sendByCtrlEnter?: boolean;
  /**
   * Mobile/touch layout. When set, plain Enter inserts a newline instead of
   * sending (the on-screen keyboard's Return should not fire the message).
   */
  isMobile?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
}

interface MentionableFile {
  name: string;
  path: string;
}

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  claudeModel,
  codexModel,
  antigravityModel,
  currentProviderEffort,
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  isMobile,
  onSessionProcessing,
  onSessionEstablished,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      // Draft inputs are keyed by the DB projectId so per-project drafts
      // survive display-name changes.
      return safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handleSubmitRef = useRef<
    // Resolves to `true` when a run was actually started (a chat.send was
    // dispatched), `false` otherwise (queued, intercepted as a command, or an
    // early/failed exit). The queue drain uses this to know whether to wait for
    // a completion edge or keep draining immediately.
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<boolean>) | null
  >(null);
  const inputValueRef = useRef(input);
  const submitInFlightRef = useRef(false);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;

  const {
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    handlePaste,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    resetImages,
  } = useComposerImageAttachments();

  const { queuedDrafts, enqueueDraft, editQueuedDraft, deleteQueuedDraft } = useQueuedDrafts({
    sessionKey,
    isLoading,
    setInput,
    inputValueRef,
    setAttachedImages,
    addMessage,
    handleSubmitRef,
    textareaRef,
  });

  const { executeCommand, commandModalPayload, closeCommandModal, showCostModal } = useComposerCommands({
    selectedProject,
    currentSessionId,
    provider,
    claudeModel,
    codexModel,
    antigravityModel,
    tokenBudget,
    input,
    setInput,
    inputValueRef,
    handleSubmitRef,
    addMessage,
    onFileOpen,
    onShowSettings,
  });

  const {
    slashCommands,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const {
    inputHighlightRef,
    isTextareaExpanded,
    syncInputOverlayScroll,
    handleTextareaClick,
    handleTextareaInput,
    handleClearInput,
  } = useComposerTextarea({
    input,
    setInput,
    inputValueRef,
    resetCommandMenuState,
    setCursorPosition,
    textareaRef,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => {
      try {
        const settingsKey = provider === 'codex'
          ? 'codex-settings'
          : provider === 'antigravity'
            ? 'antigravity-settings'
            : 'claude-settings';
        const savedSettings = safeLocalStorage.getItem(settingsKey);
        if (savedSettings) {
          return JSON.parse(savedSettings);
        }
      } catch (error) {
        console.error('Error loading tools settings:', error);
      }

      return {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      };
    };

    const toolsSettings = getToolsSettings();
    const model = provider === 'codex'
      ? codexModel
      : provider === 'antigravity'
        ? antigravityModel
        : claudeModel;

    return {
      model,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    antigravityModel,
    claudeModel,
    codexModel,
    currentProviderEffort,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();
      const currentInput = inputValueRef.current;
      if (!currentInput.trim() || !selectedProject) {
        return false;
      }

      if (submitInFlightRef.current) {
        return false;
      }
      submitInFlightRef.current = true;

      try {
      // A turn is already in flight: stash this message instead of sending it.
      // Appended to the tail of the queue (not overwriting the existing one), so
      // multiple messages queue in order and each is auto-flushed once the prior
      // turn ends — still going through slash-command interception, image
      // upload, etc.
      if (isLoading) {
        enqueueDraft(currentInput, attachedImages, buildSendOptions(currentInput));
        setInput('');
        inputValueRef.current = '';
        resetImages();
        resetCommandMenuState();
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        // selectedProject is guaranteed by the guard at the top of handleSubmit.
        safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
        return false;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (commandInput.startsWith('/') || isHelpAlias) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          recordFeatureUse('chat.slash_command');
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          setInput('');
          inputValueRef.current = '';
          resetImages();
          resetCommandMenuState();
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          // A built-in command runs inline; no chat.send / run started.
          return false;
        }
      }

      const messageContent = currentInput;

      let uploadedImages: unknown[] = [];
      if (attachedImages.length > 0) {
        const formData = new FormData();
        attachedImages.forEach((file) => {
          formData.append('images', file);
        });

        try {
          const response = await authenticatedFetch('/api/assets/images', {
            method: 'POST',
            headers: {},
            body: formData,
          });

          if (!response.ok) {
            throw new Error('Failed to upload images');
          }

          const result = await response.json();
          uploadedImages = result.images;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Image upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload images: ${message}`,
            timestamp: new Date(),
          });
          return false;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        try {
          const response = await authenticatedFetch('/api/providers/sessions', {
            method: 'POST',
            body: JSON.stringify({
              provider,
              projectPath: resolvedProjectPath,
            }),
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return false;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return false;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: sessionSummary,
        });
      }

      const sentAt = new Date();
      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
        images: uploadedImages as any,
        timestamp: sentAt,
      };

      const sendOptions = {
        ...buildSendOptions(messageContent),
        images: uploadedImages,
      };

      // Record the message BEFORE handing it to the socket. Until the server
      // echoes it back this is the only durable copy: the optimistic bubble is
      // in-memory only and the draft key is cleared below, so a frame lost in
      // transit used to take the message with it (#325).
      const pendingSendId = makePendingSendId();
      appendPendingSend(targetSessionId, {
        id: pendingSendId,
        content: messageContent,
        timestamp: sentAt.toISOString(),
        options: sendOptions,
        // Written as undelivered and promoted only once the socket accepts it,
        // so a failure between these two points errs toward "never sent" — the
        // reading that is safe to retry.
        dispatched: false,
      });

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      recordFeatureUse('chat.send');
      const dispatched = sendMessage({
        type: 'chat.send',
        sessionId: targetSessionId,
        content: messageContent,
        options: sendOptions,
        // Echoed back in `chat_send_accepted`, which is what confirms this entry
        // outright instead of inferring delivery from a transcript echo that a
        // queued message will not produce for minutes (#389).
        clientMessageId: pendingSendId,
      });

      if (!dispatched) {
        // No run started, so do NOT flip the activity indicator — that is what
        // made an undelivered message look like one awaiting a reply. The text
        // is safe in the pending store and goes out on the next reconnect.
        addMessage(userMessage);
        addMessage({
          type: 'error',
          content:
            "You appear to be offline, so this message hasn't been sent yet. "
            + "It's saved and will be sent automatically when the connection comes back.",
          timestamp: new Date(),
        });
        setInput('');
        inputValueRef.current = '';
        resetCommandMenuState();
        resetImages();
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
        return false;
      }

      markPendingSendDispatched(targetSessionId, pendingSendId);

      // ── Post-dispatch bookkeeping: none of this is optional (#450) ────────
      //
      // The socket has accepted the frame, so the message is the server's now —
      // running or queued, and the client cannot recall it. Anything skipped
      // below therefore leaves the UI describing a send that did not happen.
      //
      // That is exactly what used to go wrong. `addMessage` routes through the
      // session store, and a single malformed realtime row (an id-less
      // `chat_resumed` frame) made it throw. `handleSubmit` is `async`, so the
      // throw surfaced only as an unhandled rejection: no bubble, no spinner,
      // and the user's text still sitting in the composer — while the run was
      // already going on the server. The natural response is to press send
      // again, and every press mints a fresh `clientMessageId`, which is the one
      // key the server dedupes on, so each duplicate ran for real (#450/#448).
      //
      // Ordering note: the optimistic bubble stays ahead of the composer reset,
      // so the happy path renders exactly as before and there is no window
      // where the input is empty and no message has appeared. Unfailability
      // comes from the `finally` instead of from reordering.
      try {
        // The activity indicator goes first: it is a plain flag with no store
        // involvement, and it is the feedback that stops a second press even if
        // the optimistic bubble below cannot be rendered.
        onSessionProcessing?.(targetSessionId, {
          statusText: null,
          canInterrupt: true,
        });

        // The fallible step. Losing the optimistic bubble is cosmetic — the
        // server echoes the message back — so it must not be able to take the
        // composer reset down with it.
        addMessage(userMessage);

        setIsUserScrolledUp(false);
        setTimeout(() => scrollToBottom(), 100);
      } catch (error) {
        console.error(
          '[Chat] Post-send UI update failed; the message was still sent:',
          { sessionId: targetSessionId, clientMessageId: pendingSendId },
          error,
        );
      } finally {
        setInput('');
        inputValueRef.current = '';
        resetCommandMenuState();
        resetImages();

        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }

        safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
      }
      // A chat.send was dispatched: a run has started.
      return true;
      } finally {
        submitInFlightRef.current = false;
      }
    },
    [
      selectedSession,
      attachedImages,
      buildSendOptions,
      currentSessionId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
      enqueueDraft,
      resetImages,
      textareaRef,
    ],
  );

  // Layout effects run before every passive effect, so sub-hooks called earlier
  // (useQueuedDrafts' auto-drain) always see the current handleSubmit.
  useLayoutEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProjectId}`) || '';
    // Text shared into the app from elsewhere lands here, the first moment there
    // is a project to attach it to (#370). It is claimed exactly once — read and
    // cleared together — so switching projects afterwards does not paste it a
    // second time. It appends rather than replaces so it can never eat a draft
    // the user had already typed.
    const shared = safeLocalStorage.getItem(SHARED_TEXT_KEY) || '';
    if (shared) {
      safeLocalStorage.removeItem(SHARED_TEXT_KEY);
    }
    const seeded = shared
      ? [savedInput.trim(), shared].filter(Boolean).join('\n\n')
      : savedInput;

    setInput((previous) => {
      const next = previous === seeded ? previous : seeded;
      inputValueRef.current = next;
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProjectId}`, input);
    } else {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [input, selectedProjectId]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        const action = resolveEnterKeyAction({
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          isComposing: event.nativeEvent.isComposing,
          sendByCtrlEnter: Boolean(sendByCtrlEnter),
          isMobile: Boolean(isMobile),
        });

        if (action === 'submit') {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      isMobile,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    recordFeatureUse('chat.interrupt');
    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const { handleGrantToolPermission, handlePermissionDecision } = useComposerPermissions({
    provider,
    sendMessage,
    setPendingPermissionRequests,
  });

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    queuedDrafts,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
