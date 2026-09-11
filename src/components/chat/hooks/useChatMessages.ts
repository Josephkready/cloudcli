/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';

function formatToolResultContent(content: unknown): string {
  // A throw in here takes down the whole transcript render, not just one message
  // (#463). JSON.stringify returns the *value* undefined (not a string) for
  // undefined/function/symbol input, and throws outright on circular refs or a
  // throwing toJSON — so a contentless (or exotic) tool_result must not be able to
  // crash the tool_use inline-result branch, which passes tr.content unguarded.
  // Coerce here so every caller is safe regardless of what it hands in.
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else {
    try {
      text = JSON.stringify(content) ?? '';
    } catch {
      text = '';
    }
  }
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

type ParsedTaskNotification = {
  status: string;
  summary: string;
  result: string;
};

/**
 * Parses a background-agent `<task-notification>` block.
 *
 * The harness injects these as user-role messages when a background task stops.
 * Newer notifications carry extra fields (`<tool-use-id>`, `<note>`, `<usage>`,
 * and a `<result>` markdown payload) that the previous single-shot regex could
 * not match, so the whole raw XML block leaked through as plain user text.
 * Fields are extracted independently so the block renders as an assistant
 * notification plus, when present, the agent's markdown result.
 */
function parseTaskNotification(content: string): ParsedTaskNotification | null {
  if (!content.trimStart().startsWith('<task-notification>')) {
    return null;
  }

  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(content);
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);

  let result = '';
  const resultOpen = content.indexOf('<result>');
  if (resultOpen !== -1) {
    const afterOpen = content.slice(resultOpen + '<result>'.length);
    const closeIndex = afterOpen.indexOf('</result>');
    result =
      closeIndex === -1
        ? afterOpen.replace(/<\/task-notification>\s*$/, '').trim()
        : afterOpen.slice(0, closeIndex).trim();
  }

  return {
    status: statusMatch?.[1]?.trim() || 'completed',
    summary: summaryMatch?.[1]?.trim() || 'Background task finished',
    result,
  };
}

/**
 * Resolves the tool_result a `tool_use` row should render, the same way
 * whether it is used to convert the row or just to fingerprint it for reuse
 * (see `derivationCache` below) — one source of truth so the two can never
 * drift apart.
 *
 * Prefer an inline result; otherwise fall back to the standalone tool_result
 * map — but skip that fallback when another tool_use sharing this call_id
 * already owns the result inline, so a multi-file patch's result renders only
 * on that owner Edit, not on every file (#119).
 */
function resolveToolUseResult(
  msg: NormalizedMessage,
  toolResultMap: Map<string, NormalizedMessage>,
  inlineResultToolIds: Set<string>,
) {
  return (
    msg.toolResult ||
    (msg.toolId && !inlineResultToolIds.has(msg.toolId) ? toolResultMap.get(msg.toolId) : null)
  );
}

/**
 * Converts a single `NormalizedMessage` row to the zero, one, or two
 * `ChatMessage`s it renders as. Depends only on `msg` itself plus the
 * cross-row lookups built once per `normalizedToChatMessages` call — never on
 * iteration order or on any other row's *output* — so it is safe to cache per
 * row (see `normalizedToChatMessages`).
 */
function convertOneMessage(
  msg: NormalizedMessage,
  toolResultMap: Map<string, NormalizedMessage>,
  toolUseIds: Set<string>,
  inlineResultToolIds: Set<string>,
): ChatMessage[] {
  const sharedMetadata = {
    displayText: msg.displayText,
    commandName: msg.commandName,
    commandMessage: msg.commandMessage,
    commandArgs: msg.commandArgs,
    isLocalCommand: msg.isLocalCommand,
    isLocalCommandStdout: msg.isLocalCommandStdout,
    isCompactSummary: msg.isCompactSummary,
  };

  switch (msg.kind) {
    case 'text': {
      const content = msg.content || '';
      const images = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined;
      if (!content.trim() && !images) return [];

      if (msg.role === 'user') {
        // Parse task notifications
        const taskNotif = parseTaskNotification(content);
        if (taskNotif) {
          const out: ChatMessage[] = [
            {
              type: 'assistant',
              content: taskNotif.summary,
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: taskNotif.status,
              ...sharedMetadata,
            },
          ];
          // Render the agent's result as a normal assistant message so its
          // markdown displays correctly instead of leaking raw XML.
          if (taskNotif.result) {
            out.push({
              type: 'assistant',
              content: formatUsageLimitText(unescapeWithMathProtection(decodeHtmlEntities(taskNotif.result))),
              timestamp: msg.timestamp,
              ...sharedMetadata,
            });
          }
          return out;
        }
        return [
          {
            type: 'user',
            content: unescapeWithMathProtection(decodeHtmlEntities(content)),
            timestamp: msg.timestamp,
            images,
            ...sharedMetadata,
          },
        ];
      }

      let text = decodeHtmlEntities(content);
      text = unescapeWithMathProtection(text);
      text = formatUsageLimitText(text);
      return [
        {
          type: 'assistant',
          content: text,
          timestamp: msg.timestamp,
          ...sharedMetadata,
        },
      ];
    }

    case 'tool_use': {
      const tr = resolveToolUseResult(msg, toolResultMap, inlineResultToolIds);
      const isSubagentContainer = msg.toolName === 'Task';

      // Build child tools from subagentTools
      const childTools: SubagentChildTool[] = [];
      if (isSubagentContainer && msg.subagentTools && Array.isArray(msg.subagentTools)) {
        for (const tool of msg.subagentTools as any[]) {
          childTools.push({
            toolId: tool.toolId,
            toolName: tool.toolName,
            toolInput: tool.toolInput,
            toolResult: tool.toolResult || null,
            timestamp: new Date(tool.timestamp || Date.now()),
          });
        }
      }

      const toolResult = tr
        ? {
            content: formatToolResultContent(tr.content),
            isError: Boolean(tr.isError),
            toolUseResult: (tr as any).toolUseResult,
          }
        : null;

      return [
        {
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          isSubagentContainer,
          subagentState: isSubagentContainer
            ? {
                childTools,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: Boolean(toolResult),
              }
            : undefined,
          ...sharedMetadata,
        },
      ];
    }

    case 'thinking':
      if (msg.content?.trim()) {
        return [
          {
            type: 'assistant',
            content: unescapeWithMathProtection(msg.content),
            timestamp: msg.timestamp,
            isThinking: true,
            ...sharedMetadata,
          },
        ];
      }
      return [];

    case 'error':
      return [
        {
          type: 'error',
          content: msg.content || 'Unknown error',
          timestamp: msg.timestamp,
          ...sharedMetadata,
        },
      ];

    case 'interactive_prompt':
      return [
        {
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
          ...sharedMetadata,
        },
      ];

    case 'task_notification':
      return [
        {
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
          ...sharedMetadata,
        },
      ];

    case 'stream_delta':
      if (msg.content) {
        return [
          {
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
            ...sharedMetadata,
          },
        ];
      }
      return [];

    // stream_end, complete, status, permission_*, session_created
    // are control events — not rendered as messages
    case 'stream_end':
    case 'complete':
    case 'status':
    case 'permission_request':
    case 'permission_cancelled':
    case 'session_created':
      // Skip — these are handled by useChatRealtimeHandlers
      return [];

    // tool_result is handled via attachment to tool_use above
    case 'tool_result': {
      if (msg.toolId && toolUseIds.has(msg.toolId)) {
        return [];
      }

      // A result with a toolId but no matching tool_use in the loaded set is
      // almost always a tool_use/tool_result pair split across a pagination
      // boundary (older page not loaded yet). Rendering its raw content here
      // produces an unstyled dump that "fixes itself" once the older page
      // loads; skip it and let it attach to its tool_use when that arrives.
      if (msg.toolId) {
        return [];
      }

      const content = formatToolResultContent(msg.content || '');
      if (!content.trim()) {
        return [];
      }

      return [
        {
          type: msg.isError ? 'error' : 'assistant',
          content,
          timestamp: msg.timestamp,
          toolId: msg.toolId,
          ...sharedMetadata,
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * Per-row memoization for `normalizedToChatMessages`, keyed on the source
 * row's own object identity.
 *
 * The session store (`useSessionStore.ts`) never mutates a `NormalizedMessage`
 * in place — a changed row is always a new object — so reference identity
 * already IS "content version" for every row except `tool_use`, whose
 * rendered output also depends on a *different* row (its tool_result, which
 * commonly arrives later in the array). `resultRef` below is that dependency's
 * resolved value, captured alongside the cached output so a later tick that
 * changes only the lookup result (not the tool_use row itself) still
 * recomputes that one row instead of serving a stale "no result yet" render.
 *
 * A `WeakMap` needs no eviction: once the store drops a row (pagination
 * trimming, a fresh transcript replacing the array), nothing else references
 * it and the entry is collected with it.
 */
const derivationCache = new WeakMap<NormalizedMessage, { resultRef: unknown; output: ChatMessage[] }>();

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they can render like normal chat.
 *
 * Streaming appends/replaces one row roughly every 100ms (`updateStreaming`),
 * leaving every earlier row's reference untouched — this used to rebuild the
 * whole output array from scratch on every one of those ticks regardless,
 * which is what made this scale with total conversation size instead of with
 * the size of the turn actually changing. `derivationCache` lets an unchanged
 * row reuse its previous output instead of being re-parsed.
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment. Cheap bookkeeping only
  // (Set/Map inserts over primitive fields) — not the cost this cache targets
  // — so it stays a full O(n) pass every call rather than being incrementalized.
  const toolResultMap = new Map<string, NormalizedMessage>();
  const toolUseIds = new Set<string>();
  // Tool ids whose result is already carried inline on a specific tool_use.
  // A single Codex apply_patch touching N files expands into N Edits that all
  // reuse one call_id, and the provider attaches the one shared result to just
  // the last of them (attachCodexToolResults). Without this guard the fallback
  // map below would re-attach that same standalone result to the other N-1
  // Edits too, rendering the result block once per file (#119).
  const inlineResultToolIds = new Set<string>();
  for (const msg of messages) {
    if (msg.kind === 'tool_use' && msg.toolId) {
      toolUseIds.add(msg.toolId);
      if (msg.toolResult) {
        inlineResultToolIds.add(msg.toolId);
      }
    }

    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  for (const msg of messages) {
    const resultRef =
      msg.kind === 'tool_use' ? resolveToolUseResult(msg, toolResultMap, inlineResultToolIds) : undefined;

    const cached = derivationCache.get(msg);
    if (cached && cached.resultRef === resultRef) {
      converted.push(...cached.output);
      continue;
    }

    const output = convertOneMessage(msg, toolResultMap, toolUseIds, inlineResultToolIds);
    derivationCache.set(msg, { resultRef, output });
    converted.push(...output);
  }

  return converted;
}
