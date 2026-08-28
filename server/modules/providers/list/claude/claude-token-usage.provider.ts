import fsp from 'node:fs/promises';
import readline from 'node:readline';
import fs from 'node:fs';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveClaudeJsonlPath } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { readFileTail } from '@/shared/utils.js';

/**
 * Token-usage summary shape returned to the frontend for a Claude session.
 *
 * Matches the legacy `/api/projects/.../sessions/.../token-usage` payload so
 * the React `tokenBudget` consumers keep working without changes.
 */
export type ClaudeTokenUsage = {
  used: number;
  total: number;
  breakdown: {
    input: number;
    cacheCreation: number;
    cacheRead: number;
  };
};

const DEFAULT_CONTEXT_WINDOW = 160000;

type ResolveClaudeJsonlPath = typeof resolveClaudeJsonlPath;

type GetClaudeSessionTokenUsageDependencies = {
  /** Returns the indexed session row (or null) for a given sessionId. */
  getSessionById: (sessionId: string) => {
    jsonl_path: string | null;
    project_path: string | null;
  } | null;
  /** Resolves the JSONL path that actually exists on disk now. */
  resolveJsonlPath: ResolveClaudeJsonlPath;
  /** Reads CONTEXT_WINDOW env override, returning a positive integer or null. */
  readContextWindowOverride: () => number | null;
};

function readDefaultContextWindowOverride(): number | null {
  const raw = process.env.CONTEXT_WINDOW;
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const defaultDependencies: GetClaudeSessionTokenUsageDependencies = {
  getSessionById: (sessionId) => {
    const row = sessionsDb.getSessionById(sessionId);
    if (!row) {
      return null;
    }
    return {
      jsonl_path: row.jsonl_path ?? null,
      project_path: row.project_path ?? null,
    };
  },
  resolveJsonlPath: resolveClaudeJsonlPath,
  readContextWindowOverride: readDefaultContextWindowOverride,
};

/**
 * Builds the empty token-usage payload used when a session is unknown, has no
 * file on disk, or contains no assistant messages with usage data.
 */
function buildEmptyTokenUsage(contextWindow: number): ClaudeTokenUsage {
  return {
    used: 0,
    total: contextWindow,
    breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
  };
}

type AssistantUsage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/**
 * How much of the end of a transcript to search before falling back to a full
 * scan.
 *
 * Claude appends a `usage` block to every assistant turn, so the record this
 * function wants is almost always the last few lines of the file. 256 KiB spans
 * many turns even for verbose ones, and matches the window the session
 * synchronizer already uses to find title events.
 */
const USAGE_SCAN_TAIL_BYTES = 256 * 1024;

/** Returns the last assistant `usage` block in a chunk of JSONL, if any. */
function findLatestAssistantUsage(lines: string[]): AssistantUsage | null {
  // Backwards: the newest usage record wins, so the first hit from the end is
  // the answer and there is no reason to parse the rest.
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'assistant' && entry.message?.usage) {
        return entry.message.usage as AssistantUsage;
      }
    } catch {
      // Skip malformed lines that can happen during concurrent writes.
    }
  }
  return null;
}

/**
 * Returns the latest assistant `usage` record in a session transcript.
 *
 * Reads the tail first. The value is by definition the *last* one in the file,
 * so streaming the whole transcript to find it was O(file) work to read a few
 * hundred bytes at the end — and this endpoint is called every time a
 * conversation is opened, alongside the (also O(file)) history read, on the
 * same single-threaded server. A multi-megabyte transcript paid that twice.
 *
 * Falls back to a full scan when the tail holds no usage record at all, so a
 * transcript whose only assistant turns are older than the window still
 * reports correctly rather than reporting zero.
 */
async function readLatestAssistantUsage(filePath: string): Promise<AssistantUsage | null> {
  // Whether the tail covered the whole file is a question about *bytes*, and it
  // has to be asked of the file rather than of the decoded string. `tail.length`
  // counts UTF-16 code units after decoding, so a transcript containing any
  // multi-byte character (an emoji, a smart quote, any non-Latin script — none
  // of them rare in a real conversation) decodes 256 KiB into far fewer units,
  // and a genuinely partial read would read as complete.
  //
  // The consequence is bounded rather than dramatic, which is why it survived
  // review once: the truncated first line would be kept, but the scan runs
  // backwards and reaches it only after everything newer, at which point it
  // fails `JSON.parse` and is skipped. It costs one `stat` to ask the right
  // question instead of relying on that.
  const { size } = await fsp.stat(filePath);
  const readWholeFile = size <= USAGE_SCAN_TAIL_BYTES;

  const tail = await readFileTail(filePath, USAGE_SCAN_TAIL_BYTES);
  // Drop the first line unless the read covered the whole file: otherwise it
  // starts mid-line, and a half-line either fails to parse (harmless) or, worse,
  // parses into something unintended.
  const tailLines = tail.split('\n');
  const usableTailLines = readWholeFile ? tailLines : tailLines.slice(1);

  const fromTail = findLatestAssistantUsage(usableTailLines);
  if (fromTail) {
    return fromTail;
  }

  // Nothing in the recent window carried usage, so the answer is further back
  // and the O(file) scan is unavoidable. Logged because this is the slow path
  // the tail read exists to avoid — silently falling back would make a
  // transcript that always takes it indistinguishable from one that never does.
  if (!readWholeFile) {
    console.warn(
      `[TokenUsage] no usage record in the last ${USAGE_SCAN_TAIL_BYTES} bytes of ${filePath}; scanning the whole transcript.`,
    );
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let latestUsage: AssistantUsage | null = null;
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'assistant' && entry.message?.usage) {
        latestUsage = entry.message.usage as AssistantUsage;
      }
    } catch {
      // Skip malformed lines that can happen during concurrent writes.
    }
  }

  return latestUsage;
}

/**
 * Loads token usage for one Claude session. Always resolves; never throws on
 * a missing session or missing JSONL file (those produce the zeroed-out
 * `buildEmptyTokenUsage` shape so the frontend can render an empty token
 * budget instead of an error toast).
 *
 * Exported for the route handler and for direct test coverage.
 */
export async function getClaudeSessionTokenUsage(
  sessionId: string,
  dependencies: GetClaudeSessionTokenUsageDependencies = defaultDependencies,
): Promise<ClaudeTokenUsage> {
  const contextWindow = dependencies.readContextWindowOverride() ?? DEFAULT_CONTEXT_WINDOW;

  const sessionRow = dependencies.getSessionById(sessionId);
  const jsonlPath = await dependencies.resolveJsonlPath(
    sessionRow?.jsonl_path ?? null,
    sessionId,
    sessionRow?.project_path ?? null,
  );

  if (!jsonlPath) {
    return buildEmptyTokenUsage(contextWindow);
  }

  try {
    await fsp.access(jsonlPath);
  } catch {
    return buildEmptyTokenUsage(contextWindow);
  }

  const usage = await readLatestAssistantUsage(jsonlPath);
  if (!usage) {
    return buildEmptyTokenUsage(contextWindow);
  }

  const inputTokens = Number(usage.input_tokens) || 0;
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens) || 0;
  const cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;

  return {
    used: inputTokens + cacheCreationTokens + cacheReadTokens,
    total: contextWindow,
    breakdown: {
      input: inputTokens,
      cacheCreation: cacheCreationTokens,
      cacheRead: cacheReadTokens,
    },
  };
}
