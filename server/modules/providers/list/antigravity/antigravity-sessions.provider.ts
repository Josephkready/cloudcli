import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';

import { stripAntigravityTranscriptTags } from './antigravity-session-synchronizer.provider.js';

const PROVIDER = 'antigravity';

function parseTimestamp(value: unknown): string | undefined {
  const raw = readOptionalString(value);
  if (!raw) {
    return undefined;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function normalizeAntigravityHistoryStep(
  rawStep: unknown,
  sessionId: string | null,
): NormalizedMessage[] {
  const raw = readObjectRecord(rawStep);
  if (!raw) {
    return [];
  }

  const source = readOptionalString(raw.source);
  const type = readOptionalString(raw.type);
  const content = readOptionalString(raw.content);
  const stepIndex = raw.step_index;
  const baseId = `${sessionId || PROVIDER}-${typeof stepIndex === 'number' ? stepIndex : generateMessageId(PROVIDER)}`;
  const timestamp = parseTimestamp(raw.created_at);

  if (source === 'USER_EXPLICIT' && type === 'USER_INPUT' && content?.trim()) {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'text',
      role: 'user',
      content: stripAntigravityTranscriptTags(content),
    })];
  }

  if (source === 'MODEL' && type === 'PLANNER_RESPONSE' && content?.trim()) {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'text',
      role: 'assistant',
      content: content.trim(),
    })];
  }

  if (source === 'MODEL' && type && type !== 'PLANNER_RESPONSE' && content?.trim()) {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_result',
      role: 'assistant',
      toolName: type,
      toolId: baseId,
      content: content.trim(),
      isError: type === 'ERROR_MESSAGE',
    })];
  }

  if (source === 'SYSTEM' && type === 'ERROR_MESSAGE' && content?.trim()) {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'error',
      content: content.trim(),
    })];
  }

  return [];
}

export class AntigravitySessionsProvider implements IProviderSessions {
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    const content = typeof rawMessage === 'string'
      ? rawMessage
      : readOptionalString(raw?.content) ?? readOptionalString(raw?.text) ?? '';

    if (!content.trim()) {
      return [];
    }

    return [createNormalizedMessage({
      id: readOptionalString(raw?.id) ?? generateMessageId(PROVIDER),
      sessionId,
      provider: PROVIDER,
      kind: 'stream_delta',
      content,
    })];
  }

  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const limit = options.limit ?? null;
    const offset = Math.max(0, options.offset ?? 0);
    const transcriptPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
    if (!transcriptPath) {
      return { messages: [], total: 0, hasMore: false, offset, limit };
    }

    const normalized: NormalizedMessage[] = [];
    try {
      const lines = (await readFile(transcriptPath, 'utf8')).split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          normalized.push(...normalizeAntigravityHistoryStep(JSON.parse(trimmed), sessionId));
        } catch {
          // Ignore a malformed or partially-written line without losing history.
        }
      }
    } catch (error) {
      console.warn(`[AntigravityProvider] Failed to load session ${sessionId}:`, error);
      return { messages: [], total: 0, hasMore: false, offset, limit };
    }

    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, offset);
    return {
      messages: page,
      total: normalized.length,
      hasMore,
      offset,
      limit: normalizedLimit,
    };
  }
}
