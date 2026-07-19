import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { shouldExcludeProjectPath } from '@/shared/project-exclude.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyModifiedAfter,
  mapWithConcurrency,
  normalizeSessionName,
  readFileTail,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

import {
  extractTitleCandidatesFromLines,
  pickDiscoveredSessionName,
  type SessionTitleCandidates,
} from './session-title.js';
import { FileFingerprintCache } from './session-summary-cache.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Only the tail of a transcript is scanned for title-bearing events, so we cap
 * how much of each (possibly multi-MB) `.jsonl` is read into memory. 256 KiB
 * comfortably covers the most-recent `ai-title` / `custom-title` / `last-prompt`
 * events that Claude Code appends near the end.
 */
const CLAUDE_TITLE_SCAN_TAIL_BYTES = 256 * 1024;

/**
 * Upper bound on concurrent transcript reads during a scan. Overlaps I/O across
 * a large project library without fanning out an unbounded number of open file
 * descriptors.
 */
const CLAUDE_SYNC_CONCURRENCY = 12;

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Caches per-file title candidates keyed by `(mtime, size)` so a transcript
   * that hasn't changed since it was last scanned isn't re-read and re-parsed.
   * Guards against repeated cold scans (e.g. when the scan cursor can't advance
   * because a provider failed) re-doing the same tail reads.
   */
  private readonly titleCandidatesCache = new FileFingerprintCache<SessionTitleCandidates>();

  /**
   * Returns true when a JSONL file is a subagent transcript rather than a
   * top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    return path.normalize(filePath).split(path.sep).includes('subagents');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyModifiedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    const sessionFiles = files.filter((filePath) => !this.isSubagentTranscript(filePath));

    // Read/parse transcripts with bounded concurrency so a large library
    // overlaps its filesystem I/O instead of reading files strictly serially.
    const parsedRecords = await mapWithConcurrency(
      sessionFiles,
      CLAUDE_SYNC_CONCURRENCY,
      async (filePath) => {
        const parsed = await this.processSessionFile(filePath, nameMap);
        if (!parsed) {
          return null;
        }

        const timestamps = await readFileTimestamps(filePath);
        return { filePath, parsed, timestamps };
      }
    );

    // Upsert every discovered session in one transaction (in on-disk order).
    // Per-row commits fsync once each, which dominated a large cold scan; a
    // single batched transaction collapses that to one commit (#188).
    const sessionInputs = parsedRecords
      .filter((record): record is NonNullable<typeof record> => record !== null)
      .map((record) => ({
        providerSessionId: record.parsed.sessionId,
        provider: this.provider,
        projectPath: record.parsed.projectPath,
        customName: record.parsed.sessionName,
        createdAt: record.timestamps.createdAt,
        updatedAt: record.timestamps.updatedAt,
        jsonlPath: record.filePath,
      }));

    sessionsDb.createSessions(sessionInputs);

    return sessionInputs.length;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    if (shouldExcludeProjectPath(parsed.projectPath)) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
      };
    }

    // Claude Code writes model-generated `ai-title` events (and `custom-title` on a
    // user rename) into the transcript. Prefer those over the raw first-prompt
    // `display` (nameMap) so the sidebar reads as summaries, not opening lines; the
    // first prompt stays the fallback when no title event exists.
    const titleCandidates = await this.extractSessionTitleCandidatesFromEnd(filePath, parsed.sessionId);
    const sessionName = pickDiscoveredSessionName(titleCandidates, nameMap.get(parsed.sessionId));

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  private async extractSessionTitleCandidatesFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<SessionTitleCandidates> {
    try {
      const fileStat = await stat(filePath);
      const fingerprint = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };

      const cached = this.titleCandidatesCache.get(filePath, fingerprint);
      if (cached) {
        return cached;
      }

      // Title-bearing events (ai-title / custom-title / last-prompt) are appended
      // near the end of a transcript, and the extractor scans newest-first and
      // stops early — so only the tail is needed. Reading the whole (possibly
      // multi-MB) file here was the dominant cost of a cold /api/projects scan.
      const content = await readFileTail(filePath, CLAUDE_TITLE_SCAN_TAIL_BYTES);
      const candidates = extractTitleCandidatesFromLines(content.split(/\r?\n/), sessionId);
      this.titleCandidatesCache.set(filePath, fingerprint, candidates);
      return candidates;
    } catch {
      // Ignore missing/unreadable files so sync can continue.
      return {};
    }
  }
}
