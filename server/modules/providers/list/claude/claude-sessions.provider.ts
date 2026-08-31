import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

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
import { sessionsDb } from '@/modules/database/index.js';

const PROVIDER = 'claude';

/**
 * Claude stores session JSONL files under the user's home dir, but indexed
 * paths persist across container/host migrations where the HOME directory
 * changes (e.g. an older deploy ran as `node` with HOME=/home/node and a new
 * deploy runs as the host user). The stale absolute path stored in the DB
 * then points at a file that no longer exists, so message history loads as
 * empty even though the JSONL is sitting at the equivalent location under
 * the current HOME. This helper resolves the path that actually exists on
 * disk now, with a small set of well-known fallbacks.
 *
 * Exported for test coverage; callers should treat the returned value as
 * authoritative for read operations.
 */
export async function resolveClaudeJsonlPath(
  storedPath: string | null,
  sessionId: string,
  projectPath: string | null,
): Promise<string | null> {
  if (storedPath) {
    try {
      await fsp.access(storedPath, fs.constants.R_OK);
      return storedPath;
    } catch {
      // Fall through to recovery below.
    }
  }

  const homeDir = os.homedir();

  // Primary recovery: rewrite the stored absolute path by swapping its
  // home-dir prefix to the current process homedir. This handles the most
  // common migration case (HOME changed from /home/node to /home/<user>).
  if (storedPath) {
    const claudeMarker = `${path.sep}.claude${path.sep}`;
    const markerIndex = storedPath.indexOf(claudeMarker);
    if (markerIndex >= 0) {
      const candidate = path.join(homeDir, storedPath.slice(markerIndex + 1));
      try {
        await fsp.access(candidate, fs.constants.R_OK);
        return candidate;
      } catch {
        // Fall through.
      }
    }
  }

  // Secondary recovery: derive the canonical path from project_path +
  // sessionId. Claude encodes the absolute project directory by replacing
  // every non-alphanumeric (except `-`) character with `-` and storing the
  // session as `<encoded>/<sessionId>.jsonl`.
  if (projectPath) {
    const encodedProjectPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
    const candidate = path.join(homeDir, '.claude', 'projects', encodedProjectPath, `${sessionId}.jsonl`);
    try {
      await fsp.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // No more fallbacks; let the caller treat this as an empty history.
    }
  }

  return null;
}

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};

type ClaudeHistoryMessagesResult = {
  messages: NormalizedMessage[];
  total: number;
  itemTotal: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
};

async function parseAgentTools(filePath: string): Promise<AnyRecord[]> {
  const tools: AnyRecord[] = [];

  try {
    const fileStream = fs.createReadStream(filePath);
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

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              tools.push({
                toolId: part.id,
                toolName: part.name,
                toolInput: part.input,
                timestamp: entry.timestamp,
              });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content
                    .map((contentPart: AnyRecord) => contentPart?.text || '')
                    .join('\n')
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
            };
          }
        }
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  return tools;
}

async function getSessionMessages(
  sessionId: string,
  providerSessionId: string,
  normalize: (raw: AnyRecord) => NormalizedMessage[],
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    // Heal stale jsonl_path (e.g. from the pre-HOME-flip era) via the shared
    // resolver: prefer the stored path, else rewrite/derive from project_path +
    // sessionId. The DB row is keyed by the app-facing session id.
    const sessionRow = sessionsDb.getSessionById(sessionId);
    const jsonLPath = await resolveClaudeJsonlPath(
      sessionRow?.jsonl_path ?? null,
      sessionId,
      sessionRow?.project_path ?? null,
    );

    if (!jsonLPath) {
      return { messages: [], total: 0, itemTotal: 0, hasMore: false, offset: 0, limit };
    }

    const projectDir = path.dirname(jsonLPath);
    const collector = new HistoryPageCollector<NormalizedMessage>({
      limit,
      offset,
      sortKey: (message) => historyTimestampSortValue(message.timestamp),
    });
    let visibleTotal = 0;

    const fileStream = fs.createReadStream(jsonLPath);
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
        if (entry.sessionId === providerSessionId) {
          for (const message of normalize(entry)) {
            collector.add(message);
            if (message.kind !== 'tool_result') {
              visibleTotal += 1;
            }
          }
        }
      } catch {
        // Skip malformed JSONL lines that can happen during concurrent writes.
      }
    }

    const { items, hasMore } = collector.page();
    const agentIds = new Set<string>();
    for (const message of items) {
      const agentId = readObjectRecord(message.toolUseResult)?.agentId;
      if (agentId) {
        agentIds.add(String(agentId));
      }
    }

    if (agentIds.size > 0) {
      const files = new Set(await fsp.readdir(projectDir));
      const agentToolsCache = new Map<string, AnyRecord[]>();
      for (const agentId of agentIds) {
        const agentFileName = `agent-${agentId}.jsonl`;
        if (!files.has(agentFileName)) {
          continue;
        }

        const tools = await parseAgentTools(path.join(projectDir, agentFileName));
        agentToolsCache.set(agentId, tools);
      }

      for (const message of items) {
        const agentId = readObjectRecord(message.toolUseResult)?.agentId;
        const agentTools = agentId ? agentToolsCache.get(String(agentId)) : undefined;
        if (agentTools && agentTools.length > 0) {
          message.subagentTools = agentTools;
        }
      }
    }

    return {
      messages: items,
      total: visibleTotal,
      itemTotal: collector.totalItems,
      hasMore,
      offset: collector.offset,
      limit: collector.limit,
    };
  } catch (error) {
    // Deliberately NOT swallowed into an empty result. Returning `[]` here made
    // a failed read indistinguishable from a session that genuinely has no
    // messages, and the client applied that over the loaded transcript — the
    // whole conversation vanished while the file on disk was intact (#320).
    //
    // Note what still resolves empty rather than throwing: the `!jsonLPath`
    // branch above (a session with no transcript yet) and unparseable
    // individual lines (skipped inline, since Claude Code appends to this file
    // while we read it). Only a real I/O failure reaches here.
    console.error(`Error reading messages for session ${sessionId}:`, error);
    throw new AppError(`Could not read the transcript for session "${sessionId}".`, {
      code: 'SESSION_TRANSCRIPT_UNREADABLE',
      statusCode: 500,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  // Newer Claude builds wrap the caveat banner in a tag, so the bare `Caveat:`
  // prefix above no longer matches on its own.
  '<local-command-caveat>',
  '[Request interrupted',
  // Skill invocations inject a user-role preamble starting with this line. When
  // it isn't flagged `isMeta`, it would otherwise render as a plain user bubble.
  'Base directory for this skill:',
] as const;

export function isInternalContent(content: string): boolean {
  // Match after leading whitespace: the same banner is sometimes emitted with a
  // leading newline, which would otherwise defeat every prefix below.
  const text = content.trimStart();
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * Background-task notifications are user-role rows that the frontend
 * re-attributes to the assistant (see `parseTaskNotification`). They must
 * survive the agent-authored filter below so that re-attribution still runs.
 */
export function isTaskNotificationContent(content: string): boolean {
  return content.trimStart().startsWith('<task-notification>');
}

/**
 * True when a `role: 'user'` row was produced by the agent or the harness
 * rather than typed by the person using the app.
 *
 * Attribution used to be inferred from message *content* — a hardcoded list of
 * prefixes. That can never keep up: every new harness string (stop-hook
 * feedback, skill re-invocation banners, peer/coordinator relays,
 * auto-continuation nudges, `[Image: ...]` placeholders) shows up as a blue
 * user bubble until someone adds one more prefix.
 *
 * Both transports actually label these rows explicitly, just with different
 * field names, and neither was being read for the live case:
 * - persisted JSONL sets `isMeta: true`
 * - the live SDK stream sets `isSynthetic: true` and/or `origin.kind`
 *   (`origin` absent or `human` means real keyboard input)
 *
 * `isMeta` does not exist on the live stream, so a running session rendered
 * every synthetic turn as if the user had sent it, and the same turn vanished
 * on reload once the `isMeta`-tagged transcript was read back.
 *
 * Every check here is a positive assertion of non-human origin: a genuine user
 * message (and a tool_result row, which carries none of these fields) is never
 * matched, so local-echo reconciliation is unaffected.
 */
export function isAgentAuthoredUserTurn(raw: AnyRecord): boolean {
  if (raw.isMeta === true) return true;
  if (raw.isSynthetic === true) return true;
  // Subagent (Task) turns, whose prompt is written by the parent agent. This is
  // a persisted-transcript flag only — the SDK stream has no `isSidechain`, so
  // a live subagent turn is caught by `isSynthetic`/`origin` above instead.
  if (raw.isSidechain === true) return true;

  // Anything that is not a plain object (or has a non-string `kind`) fails
  // closed to "human", so a malformed row is never silently hidden.
  const originKind = readObjectRecord(raw.origin)?.kind;
  return typeof originKind === 'string' && originKind !== 'human';
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.type === 'content_block_delta' && raw.delta?.text) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
    }
    if (raw.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    if (raw.message?.role === 'user' && raw.message?.content) {
      // Agent/harness-authored turns keep their tool results and their
      // re-attributed assistant text, but must never produce a user bubble.
      const agentAuthored = isAgentAuthoredUserTurn(raw);
      const rendersAsUserText = (text: string): boolean => {
        if (!text || isInternalContent(text)) return false;
        if (isTaskNotificationContent(text)) return true;
        return !agentAuthored;
      };

      if (Array.isArray(raw.message.content)) {
        // Image attachments sent through the SDK are persisted as base64
        // `image` blocks next to the prompt text. Collect them so the UI can
        // render them on the user bubble.
        const imageAttachments: Array<{ data: string }> = [];
        for (const part of raw.message.content) {
          if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
            const mediaType = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
            imageAttachments.push({ data: `data:${mediaType};base64,${part.source.data}` });
          }
        }
        let imagesAttached = false;

        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              // JSON.stringify(undefined) is the value undefined, not a string, so
              // a contentless tool_result would otherwise write undefined into a
              // field consumers read as a string. Coerce at the source (#463).
              content: typeof part.content === 'string' ? part.content : (JSON.stringify(part.content) ?? ''),
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            if (rendersAsUserText(text)) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: text,
                images: !imagesAttached && imageAttachments.length > 0 ? imageAttachments : undefined,
              }));
              imagesAttached = true;
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (rendersAsUserText(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
              images: imageAttachments.length > 0 ? imageAttachments : undefined,
            }));
            imagesAttached = true;
          }
        }

        // Image-only turns still deserve a user bubble even without text.
        if (!imagesAttached && imageAttachments.length > 0 && !agentAuthored) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_images`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: '',
            images: imageAttachments,
          }));
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        if (rendersAsUserText(text)) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: text,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    return messages;
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
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
    const providerSessionId = options.providerSessionId ?? sessionId;

    // A read failure is intentionally allowed to propagate to the route rather
    // than being reported as an empty page. Presenting a failure as "no
    // messages" is what let a transient read error blank a live conversation
    // (#320); an honest error lets the client show a retryable error state
    // instead of an empty thread that reads as data loss.
    const result = await getSessionMessages(
      sessionId,
      providerSessionId,
      (raw) => this.normalizeMessage(raw, sessionId),
      retentionLimit,
      0,
    );

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const message of result.messages) {
      if (message.kind === 'tool_result' && message.toolId) {
        toolResultMap.set(message.toolId, {
          content: message.content,
          isError: Boolean(message.isError),
          subagentTools: message.subagentTools,
          toolUseResult: message.toolUseResult,
        });
      }
    }

    const normalized = result.messages;

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          // toolResult.content is typed string but can be undefined for a
          // contentless result; JSON.stringify(undefined) would keep it undefined,
          // breaking the `content: string` contract on msg.toolResult (#463).
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : (JSON.stringify(toolResult.content) ?? ''),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
      }
    }

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
    };
  }
}
