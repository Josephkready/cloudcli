import fsSync from 'node:fs';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import { toImageAttachments } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  AppError,
  createNormalizedMessage,
  generateMessageId,
  HistoryPageCollector,
  historyTimestampSortValue,
  readObjectRecord,
  sliceTailPage,
} from '@/shared/utils.js';

import { parseApplyPatch } from './apply-patch.js';

const PROVIDER = 'codex';

/**
 * Pairs each Codex `tool_use` with its `tool_result` in place.
 *
 * A single Codex `apply_patch` touching multiple files is expanded into one
 * `Edit` per file (#99), and every Edit reuses the patch's `call_id`. There is
 * only ever one shared `custom_tool_call_output` for that `call_id`, so
 * attaching it to *every* Edit rendered the same "Success. Updated …" block once
 * per file (#119). To keep the transcript readable while still leaving no Edit
 * silently result-less on the common single-file path, the result is attached
 * to only the **last** `tool_use` sharing a `call_id` — it then reads once,
 * after the final file's diff, and the earlier Edits stay output-less.
 *
 * Exported for tests.
 */
export function attachCodexToolResults(normalized: NormalizedMessage[]): void {
  const toolResultMap = new Map<string, NormalizedMessage>();
  for (const msg of normalized) {
    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  // Walk backwards so the first tool_use we see for a given call_id is the last
  // one in transcript order; claim the result there and skip earlier duplicates.
  const claimed = new Set<string>();
  for (let i = normalized.length - 1; i >= 0; i--) {
    const msg = normalized[i];
    if (msg.kind !== 'tool_use' || !msg.toolId || claimed.has(msg.toolId)) {
      continue;
    }
    const toolResult = toolResultMap.get(msg.toolId);
    if (toolResult) {
      msg.toolResult = { content: toolResult.content, isError: toolResult.isError };
      claimed.add(msg.toolId);
    }
  }
}

type CodexHistoryResult = {
  messages: NormalizedMessage[];
  total: number;
  itemTotal: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

/**
 * Reads the image attachments Codex records on `user_message` events.
 * Turns sent with `local_image` input items land in `local_images` as file
 * paths (verified against real rollout JSONL); the `images` array can carry
 * base64 data URLs, which are passed through as inline `data` attachments so
 * the UI can preview them without a file lookup.
 *
 * Exported for tests.
 */
export function extractCodexUserImages(
  payload: AnyRecord | null | undefined,
): Array<{ path?: string; data?: string }> | undefined {
  if (!payload) {
    return undefined;
  }

  const candidates = [
    ...(Array.isArray(payload.local_images) ? payload.local_images : []),
    ...(Array.isArray(payload.images) ? payload.images : []),
  ];

  const attachments: Array<{ path?: string; data?: string }> = [];
  for (const entry of candidates) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    if (entry.startsWith('data:')) {
      attachments.push({ data: entry });
    } else {
      attachments.push(...toImageAttachments([entry]));
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

function extractCodexTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function getCodexSessionMessages(
  sessionId: string,
  normalize: (raw: AnyRecord) => NormalizedMessage[],
  limit: number | null = null,
  offset = 0,
): Promise<CodexHistoryResult> {
  try {
    const sessionFilePath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, itemTotal: 0, hasMore: false, offset: 0, limit };
    }

    const collector = new HistoryPageCollector<NormalizedMessage>({
      limit,
      offset,
      sortKey: (message) => historyTimestampSortValue(message.timestamp),
    });
    let visibleTotal = 0;
    let tokenUsage: AnyRecord | null = null;
    const addHistoryEntry = (raw: AnyRecord) => {
      for (const message of normalize(raw)) {
        collector.add(message);
        if (message.kind !== 'tool_result') {
          visibleTotal += 1;
        }
      }
    };
    const fileStream = fsSync.createReadStream(sessionFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
          const info = entry.payload.info as AnyRecord;
          if (info.total_token_usage) {
            const usage = info.total_token_usage as AnyRecord;
            tokenUsage = {
              used: usage.total_tokens || 0,
              total: info.model_context_window || 200000,
            };
          }
        }

        if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
          addHistoryEntry({
            type: 'user',
            timestamp: entry.timestamp,
            message: {
              role: 'user',
              content: entry.payload.message,
            },
            images: extractCodexUserImages(entry.payload as AnyRecord),
          });
        }

        if (
          entry.type === 'response_item' &&
          entry.payload?.type === 'message' &&
          entry.payload.role === 'assistant'
        ) {
          const textContent = extractCodexTextContent(entry.payload.content);
          if (textContent.trim()) {
            addHistoryEntry({
              type: 'assistant',
              timestamp: entry.timestamp,
              message: {
                role: 'assistant',
                content: textContent,
              },
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
          const summaryText = Array.isArray(entry.payload.summary)
            ? entry.payload.summary
                .map((item: AnyRecord) => item?.text)
                .filter(Boolean)
                .join('\n')
            : '';

          if (summaryText.trim()) {
            addHistoryEntry({
              type: 'thinking',
              timestamp: entry.timestamp,
              message: {
                role: 'assistant',
                content: summaryText,
              },
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
          let toolName = entry.payload.name;
          let toolInput = entry.payload.arguments;

          if (toolName === 'shell_command') {
            toolName = 'Bash';
            try {
              const args = JSON.parse(entry.payload.arguments) as AnyRecord;
              toolInput = JSON.stringify({ command: args.command });
            } catch {
              // Keep original arguments when parsing fails.
            }
          }

          addHistoryEntry({
            type: 'tool_use',
            timestamp: entry.timestamp,
            toolName,
            toolInput,
            toolCallId: entry.payload.call_id,
          });
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
          addHistoryEntry({
            type: 'tool_result',
            timestamp: entry.timestamp,
            toolCallId: entry.payload.call_id,
            output: entry.payload.output,
          });
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call') {
          const toolName = entry.payload.name || 'custom_tool';
          const input = entry.payload.input || '';

          if (toolName === 'apply_patch') {
            // A single apply_patch call can touch multiple files; emit one Edit
            // per file so a multi-file patch no longer collapses into one
            // incorrect Edit against the first file (#99). Each Edit reuses the
            // call_id, so the single tool result attaches to all of them.
            const patchFiles = parseApplyPatch(String(input));

            if (patchFiles.length === 0) {
              // Nothing parseable (e.g. an empty patch) — pass the raw call
              // through so it still appears in the transcript.
              addHistoryEntry({
                type: 'tool_use',
                timestamp: entry.timestamp,
                toolName,
                toolInput: input,
                toolCallId: entry.payload.call_id,
              });
            } else {
              for (const file of patchFiles) {
                addHistoryEntry({
                  type: 'tool_use',
                  timestamp: entry.timestamp,
                  toolName: 'Edit',
                  toolInput: JSON.stringify({
                    // Show `old → new` when the patch renamed the file so the
                    // move isn't hidden; otherwise just the path.
                    file_path: file.movedTo ? `${file.filePath} → ${file.movedTo}` : file.filePath,
                    old_string: file.oldString,
                    new_string: file.newString,
                  }),
                  toolCallId: entry.payload.call_id,
                });
              }
            }
          } else {
            addHistoryEntry({
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName,
              toolInput: input,
              toolCallId: entry.payload.call_id,
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call_output') {
          addHistoryEntry({
            type: 'tool_result',
            timestamp: entry.timestamp,
            toolCallId: entry.payload.call_id,
            output: entry.payload.output || '',
          });
        }
      } catch {
        // Skip malformed lines.
      }
    }

    const { items, hasMore } = collector.page();
    return {
      messages: items,
      total: visibleTotal,
      itemTotal: collector.totalItems,
      hasMore,
      offset: collector.offset,
      limit: collector.limit,
      tokenUsage,
    };
  } catch (error) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    throw new AppError(`Could not read the transcript for session "${sessionId}".`, {
      code: 'SESSION_TRANSCRIPT_UNREADABLE',
      statusCode: 500,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

export class CodexSessionsProvider implements IProviderSessions {
  /**
   * Normalizes a persisted Codex JSONL entry.
   *
   * Live Codex SDK events are transformed before they reach normalizeMessage(),
   * while history entries already use a compact message/tool shape from projects.js.
   */
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'thinking' || raw.isReasoning) {
      const thinkingContent = typeof raw.message?.content === 'string'
        ? raw.message.content
        : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
      })];
    }

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : String(raw.message.content || '');
      const rawImages = Array.isArray(raw.images) && raw.images.length > 0 ? raw.images : undefined;
      if (!content.trim() && !rawImages) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content,
        images: rawImages,
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName || 'Unknown',
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: Boolean(raw.isError),
      })];
    }

    return [];
  }

  /**
   * Normalizes either a Codex history entry or a transformed live SDK event.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.message?.role) {
      return this.normalizeHistoryEntry(raw, sessionId);
    }

    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'item') {
      switch (raw.itemType) {
        case 'agent_message':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: raw.message?.content || '',
          })];
        case 'reasoning':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'thinking',
            content: raw.message?.content || '',
          })];
        case 'command_execution':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'Bash',
            toolInput: { command: raw.command },
            toolId: baseId,
            output: raw.output,
            exitCode: raw.exitCode,
            status: raw.status,
          })];
        case 'file_change':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'FileChanges',
            toolInput: raw.changes,
            toolId: baseId,
            status: raw.status,
          })];
        case 'mcp_tool_call':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.tool || 'MCP',
            toolInput: raw.arguments,
            toolId: baseId,
            server: raw.server,
            result: raw.result,
            error: raw.error,
            status: raw.status,
          })];
        case 'web_search':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'WebSearch',
            toolInput: { query: raw.query },
            toolId: baseId,
          })];
        case 'todo_list':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'TodoList',
            toolInput: { items: raw.items },
            toolId: baseId,
          })];
        case 'error':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'error',
            content: raw.message?.content || 'Unknown error',
          })];
        default:
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.itemType || 'Unknown',
            toolInput: raw.item || raw,
            toolId: baseId,
          })];
      }
    }

    if (raw.type === 'turn_complete') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'complete',
      })];
    }
    if (raw.type === 'turn_failed') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content: raw.error?.message || 'Turn failed',
      })];
    }

    return [];
  }

  /**
   * Loads Codex JSONL history and keeps token usage metadata when projects.js
   * provides it.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const normalizedOffset = Math.max(0, options.offset ?? 0);
    const normalizedLimit = options.limit === null || options.limit === undefined
      ? null
      : Math.max(0, options.limit);
    const retentionLimit = normalizedLimit === null
      ? null
      : normalizedLimit + normalizedOffset;

    let result: CodexHistoryResult;
    try {
      result = await getCodexSessionMessages(
        sessionId,
        (raw) => this.normalizeHistoryEntry(raw, sessionId),
        retentionLimit,
        0,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexProvider] Failed to load session ${sessionId}:`, message);
      throw error;
    }

    const normalized = result.messages;

    attachCodexToolResults(normalized);

    const { page } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);
    const hasMore = normalizedLimit === null
      ? false
      : Math.max(0, result.itemTotal - normalizedOffset - normalizedLimit) > 0;

    return {
      messages: page,
      total: result.total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage: result.tokenUsage,
    };
  }
}
