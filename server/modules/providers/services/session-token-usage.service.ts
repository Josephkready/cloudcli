import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { getClaudeSessionTokenUsage } from '@/modules/providers/list/claude/claude-token-usage.provider.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * Token-usage payload returned from `getSessionTokenUsage`.
 *
 * The shape is provider-agnostic but each provider may populate a different
 * subset of fields. Providers that don't surface usage data return
 * `unsupported: true` so the frontend can render an empty/disabled state.
 */
export type SessionTokenUsageResponse = {
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

function isSafeSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
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
 * Reads the latest Codex token-count event from a Codex session JSONL file
 * (events are appended in chronological order, so the last `token_count`
 * event reflects the current cumulative usage).
 */
async function readCodexTokenUsage(filePath: string): Promise<SessionTokenUsageResponse> {
  let fileContent: string;
  try {
    fileContent = await fsp.readFile(filePath, 'utf8');
  } catch {
    return {
      used: 0,
      total: CODEX_DEFAULT_CONTEXT_WINDOW,
    };
  }

  let totalTokens = 0;
  let contextWindow = CODEX_DEFAULT_CONTEXT_WINDOW;

  const lines = fileContent.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
        const info = entry.payload.info;
        if (info.total_token_usage) {
          totalTokens = Number(info.total_token_usage.total_tokens) || 0;
        }
        if (info.model_context_window) {
          contextWindow = Number(info.model_context_window) || contextWindow;
        }
        break;
      }
    } catch {
      continue;
    }
  }

  return { used: totalTokens, total: contextWindow };
}

type GetSessionTokenUsageDependencies = {
  /** Returns the indexed session row (or null) for a given sessionId. */
  getSessionById: (sessionId: string) => { provider: string } | null;
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
    return { provider: row.provider };
  },
  getClaudeUsage: getClaudeSessionTokenUsage,
  resolveCodexSessionsDir: () => path.join(os.homedir(), '.codex', 'sessions'),
};

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

  if (provider === 'cursor') {
    return buildUnsupportedResponse('Token usage tracking not available for Cursor sessions');
  }
  if (provider === 'opencode') {
    // OpenCode is a provider that landed upstream after this service was
    // extracted from index.js. Its usage lives in OpenCode's SQLite store;
    // until that reader is ported here we report it as unsupported rather
    // than silently falling through to the Claude JSONL path (which would
    // look for a Claude session file that doesn't exist).
    return buildUnsupportedResponse('Token usage tracking not available for OpenCode sessions');
  }

  if (provider === 'codex') {
    const codexDir = dependencies.resolveCodexSessionsDir();
    const sessionFilePath = await findCodexSessionFile(codexDir, sessionId);
    if (!sessionFilePath) {
      return { used: 0, total: CODEX_DEFAULT_CONTEXT_WINDOW };
    }
    return readCodexTokenUsage(sessionFilePath);
  }

  return dependencies.getClaudeUsage(sessionId);
}
