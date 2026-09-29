import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { getClaudeSessionTokenUsage } from '@/modules/providers/list/claude/claude-token-usage.provider.js';
import { iterateJsonlLines, streamJsonlEntries } from '@/shared/jsonl.js';
import { isReservedDotOnlyId } from '@/shared/session-id-guards.js';
import type { LLMProvider } from '@/shared/types.js';
import { readFileTail } from '@/shared/utils.js';

/**
 * Token-usage payload returned from `getSessionTokenUsage`.
 *
 * The shape is provider-agnostic but each provider may populate a different
 * subset of fields. Providers that don't surface usage data return
 * `unsupported: true` so the frontend can render an empty/disabled state.
 */
type SessionTokenUsageResponse = {
  used: number;
  total: number;
  breakdown?: {
    input: number;
    cacheCreation: number;
    cacheRead: number;
  };
  unsupported?: true;
  message?: string;
};

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

const CODEX_DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * Rejects ids that could steer the lookups below. The allow-list pattern keeps
 * out separators and shell metacharacters; the dot-only guard covers the case
 * the pattern can't, because `.` is a legal body character. It matters
 * concretely here: `findCodexSessionFile` matches on `entry.name.includes(id)`,
 * and every `*.jsonl` filename contains a `.`, so a bare `.` would match the
 * first session file it walks past and report an unrelated session's usage.
 */
function isSafeSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value) && !isReservedDotOnlyId(value);
}

function buildUnsupportedResponse(message: string): SessionTokenUsageResponse {
  return {
    used: 0,
    total: 0,
    breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
    unsupported: true,
    message,
  };
}

/**
 * Walks a directory tree looking for a JSONL file whose name contains the
 * given Codex session id. Codex stores files under nested date dirs so we
 * descend depth-first; we stop on the first match.
 */
async function findCodexSessionFile(rootDir: string, sessionId: string): Promise<string | null> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const found = await findCodexSessionFile(fullPath, sessionId);
      if (found) {
        return found;
      }
    } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
      return fullPath;
    }
  }

  return null;
}

/**
 * How much of the end of a Codex transcript to search before falling back to
 * a full scan. Mirrors `claude-token-usage.provider.ts`'s
 * `USAGE_SCAN_TAIL_BYTES`: Codex appends a `token_count` event per turn, so
 * the record this function wants is almost always the last few lines.
 */
const USAGE_SCAN_TAIL_BYTES = 256 * 1024;

type CodexTokenCountInfo = {
  totalTokens: number | null;
  contextWindow: number | null;
};

/** Returns the last Codex `token_count` event in a chunk of JSONL, if any. */
function findLatestCodexTokenCount(lines: string[]): CodexTokenCountInfo | null {
  for (const entry of iterateJsonlLines<any>(lines, { fromEnd: true })) {
    if (entry?.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
      const info = entry.payload.info;
      return {
        totalTokens: info.total_token_usage ? Number(info.total_token_usage.total_tokens) || 0 : null,
        contextWindow: info.model_context_window ? Number(info.model_context_window) || null : null,
      };
    }
  }
  return null;
}

/**
 * Reads the latest Codex token-count event from a Codex session JSONL file
 * (events are appended in chronological order, so the last `token_count`
 * event reflects the current cumulative usage).
 *
 * Reads the tail first — the same O(file) vs O(tail) tradeoff documented on
 * `claude-token-usage.provider.ts`'s `readLatestAssistantUsage` — and falls
 * back to a full scan only when the tail holds no `token_count` event.
 */
async function readCodexTokenUsage(filePath: string): Promise<SessionTokenUsageResponse> {
  let size: number;
  try {
    ({ size } = await fsp.stat(filePath));
  } catch {
    return {
      used: 0,
      total: CODEX_DEFAULT_CONTEXT_WINDOW,
    };
  }

  const readWholeFile = size <= USAGE_SCAN_TAIL_BYTES;
  const tail = await readFileTail(filePath, USAGE_SCAN_TAIL_BYTES);
  const tailLines = tail.split('\n');
  // A partial read starts mid-line; drop that fragment unless the tail
  // covered the whole file.
  const usableTailLines = readWholeFile ? tailLines : tailLines.slice(1);

  const fromTail = findLatestCodexTokenCount(usableTailLines);
  if (fromTail) {
    return {
      used: fromTail.totalTokens ?? 0,
      total: fromTail.contextWindow ?? CODEX_DEFAULT_CONTEXT_WINDOW,
    };
  }

  if (!readWholeFile) {
    console.warn(
      `[TokenUsage] no token_count event in the last ${USAGE_SCAN_TAIL_BYTES} bytes of ${filePath}; scanning the whole transcript.`,
    );
  }

  let totalTokens = 0;
  let contextWindow = CODEX_DEFAULT_CONTEXT_WINDOW;
  for await (const entry of streamJsonlEntries<any>(filePath)) {
    if (entry?.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
      const info = entry.payload.info;
      if (info.total_token_usage) {
        totalTokens = Number(info.total_token_usage.total_tokens) || 0;
      }
      if (info.model_context_window) {
        contextWindow = Number(info.model_context_window) || contextWindow;
      }
    }
  }

  return { used: totalTokens, total: contextWindow };
}

type GetSessionTokenUsageDependencies = {
  /** Returns the indexed session row (or null) for a given sessionId. */
  getSessionById: (sessionId: string) => { provider: string; jsonl_path?: string | null } | null;
  /** Builds the Claude token-usage response for a session id. */
  getClaudeUsage: typeof getClaudeSessionTokenUsage;
  /** Resolves the absolute path to ~/.codex/sessions. */
  resolveCodexSessionsDir: () => string;
};

const defaultDependencies: GetSessionTokenUsageDependencies = {
  getSessionById: (sessionId) => {
    const row = sessionsDb.getSessionById(sessionId);
    if (!row) {
      return null;
    }
    return { provider: row.provider, jsonl_path: row.jsonl_path ?? null };
  },
  getClaudeUsage: getClaudeSessionTokenUsage,
  resolveCodexSessionsDir: () => path.join(os.homedir(), '.codex', 'sessions'),
};

/** True if `filePath` exists and can be read. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the per-session token-usage view for the caller-supplied session.
 *
 * Provider dispatch is driven by the DB row's `provider` column. Unknown
 * sessions fall through to the Claude code path (which gracefully handles
 * missing JSONL files), matching the legacy route's `provider=claude`
 * query-param default.
 */
export async function getSessionTokenUsage(
  sessionId: string,
  dependencies: GetSessionTokenUsageDependencies = defaultDependencies,
): Promise<SessionTokenUsageResponse> {
  if (!isSafeSessionId(sessionId)) {
    return buildUnsupportedResponse('Invalid sessionId');
  }

  const sessionRow = dependencies.getSessionById(sessionId);
  const provider = (sessionRow?.provider ?? 'claude') as LLMProvider;

  if (provider === 'codex') {
    // The indexed `jsonl_path` is already known for almost every session, so
    // use it directly instead of re-discovering the file with a recursive
    // directory walk + substring match. The walk stays as a fallback for
    // legacy rows with a stale or missing `jsonl_path`.
    let sessionFilePath = sessionRow?.jsonl_path ?? null;
    if (!sessionFilePath || !(await fileExists(sessionFilePath))) {
      const codexDir = dependencies.resolveCodexSessionsDir();
      sessionFilePath = await findCodexSessionFile(codexDir, sessionId);
    }
    if (!sessionFilePath) {
      return { used: 0, total: CODEX_DEFAULT_CONTEXT_WINDOW };
    }
    return readCodexTokenUsage(sessionFilePath);
  }

  if (provider === 'antigravity') {
    return buildUnsupportedResponse('Antigravity token usage is not available for persisted sessions');
  }

  return dependencies.getClaudeUsage(sessionId);
}
