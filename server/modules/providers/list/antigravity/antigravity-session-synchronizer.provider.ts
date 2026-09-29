import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import type { DiscoveredSessionInput } from '@/modules/database/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { iterateJsonlLines } from '@/shared/jsonl.js';
import { shouldExcludeProjectPath } from '@/shared/project-exclude.js';
import {
  findFilesRecursivelyModifiedAfter,
  mapWithConcurrency,
  normalizeSessionName,
  readFileTimestamps,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const PROVIDER = 'antigravity' as const;
const UNTITLED_SESSION = 'Untitled Antigravity Session';

/**
 * Upper bound on concurrent transcript reads during a scan, mirroring the
 * Claude synchronizer's `CLAUDE_SYNC_CONCURRENCY` (same directory tree).
 */
const ANTIGRAVITY_SYNC_CONCURRENCY = 12;

type ParsedAntigravitySession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

type HistoryMetadata = { projectPath?: string; sessionName?: string };

export function getAntigravitySessionIdFromTranscriptPath(filePath: string): string | null {
  const parts = filePath.split(path.sep);
  const brainIndex = parts.lastIndexOf('brain');
  const sessionId = brainIndex >= 0 ? parts[brainIndex + 1] : null;
  return sessionId?.trim() || null;
}

export function stripAntigravityTranscriptTags(content: string): string {
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g, '$1')
    .trim();
}

function extractStepMetadata(rawLine: string): { projectPath?: string; firstUserMessage?: string } | null {
  try {
    const parsed = readObjectRecord(JSON.parse(rawLine));
    if (!parsed) {
      return null;
    }

    const source = readOptionalString(parsed.source);
    const type = readOptionalString(parsed.type);
    const content = readOptionalString(parsed.content);

    if (type === 'LIST_DIRECTORY' || type === 'VIEW_FILE') {
      const match = content?.match(/File Path: `file:\/\/([^`]+)`/);
      if (match?.[1]) {
        return { projectPath: type === 'VIEW_FILE' ? path.dirname(match[1]) : match[1] };
      }
    }

    if (source === 'USER_EXPLICIT' && type === 'USER_INPUT' && content) {
      return { firstUserMessage: stripAntigravityTranscriptTags(content) };
    }
  } catch {
    // A transcript can be observed while agy is still appending a partial line.
  }

  return null;
}

export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly antigravityHome = path.join(os.homedir(), '.gemini', 'antigravity-cli');
  private readonly brainDir = path.join(this.antigravityHome, 'brain');
  private readonly historyPath = path.join(this.antigravityHome, 'history.jsonl');

  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyModifiedAfter(this.brainDir, 'transcript.jsonl', since ?? null);

    // history.jsonl only grows, and the old per-file `readHistoryMetadata`
    // re-read + re-parsed the whole thing for every transcript in the batch
    // (O(N x history size)). Build the lookup map once per scan instead.
    const historyMap = await this.buildHistoryMetadataMap();

    // Read/parse transcripts with bounded concurrency, mirroring the Claude
    // synchronizer's pattern in the same directory tree: overlap filesystem
    // I/O across a large session library instead of scanning strictly serially.
    const parsedRecords = await mapWithConcurrency(
      files,
      ANTIGRAVITY_SYNC_CONCURRENCY,
      async (filePath) => {
        if (path.basename(filePath) !== 'transcript.jsonl') {
          return null;
        }

        const parsed = await this.processTranscriptFile(filePath, historyMap);
        if (!parsed || shouldExcludeProjectPath(parsed.projectPath)) {
          return null;
        }

        const timestamps = await readFileTimestamps(filePath);
        return { filePath, parsed, timestamps };
      }
    );

    // DB reads/writes stay serial and in on-disk order after the concurrent
    // parse, same as Claude/Codex: the "keep existing name" check + upsert run
    // in program order so two files that map to the same session id can't race.
    const sessionInputs: DiscoveredSessionInput[] = [];
    for (const record of parsedRecords) {
      if (!record) {
        continue;
      }
      const { filePath, parsed, timestamps } = record;

      const existing = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
        ?? sessionsDb.getSessionById(parsed.sessionId);
      const existingName = existing?.custom_name?.trim();
      const sessionName = existingName && existingName !== UNTITLED_SESSION
        ? existingName
        : parsed.sessionName;

      sessionInputs.push({
        providerSessionId: parsed.sessionId,
        provider: PROVIDER,
        projectPath: parsed.projectPath,
        customName: sessionName,
        createdAt: timestamps.createdAt,
        updatedAt: timestamps.updatedAt,
        jsonlPath: filePath,
      });
    }

    // Batch the upserts in one transaction (Claude synchronizer's #188 fix):
    // per-row commits each fsync once, which dominates a large cold scan.
    sessionsDb.createSessions(sessionInputs);

    return sessionInputs.length;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (path.basename(filePath) !== 'transcript.jsonl') {
      return null;
    }

    const historyMap = await this.buildHistoryMetadataMap();
    const parsed = await this.processTranscriptFile(filePath, historyMap);
    if (!parsed || shouldExcludeProjectPath(parsed.projectPath)) {
      return null;
    }

    const existing = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingName = existing?.custom_name?.trim();
    const sessionName = existingName && existingName !== UNTITLED_SESSION
      ? existingName
      : parsed.sessionName;
    const timestamps = await readFileTimestamps(filePath);

    return sessionsDb.createSession(
      parsed.sessionId,
      PROVIDER,
      parsed.projectPath,
      sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
    );
  }

  private async processTranscriptFile(
    filePath: string,
    historyMap: Map<string, HistoryMetadata>,
  ): Promise<ParsedAntigravitySession | null> {
    const sessionId = getAntigravitySessionIdFromTranscriptPath(filePath);
    if (!sessionId) {
      return null;
    }

    const historyMetadata = historyMap.get(sessionId);
    let projectPath = historyMetadata?.projectPath;
    let firstUserMessage = historyMetadata?.sessionName;

    try {
      const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/);
      for (const line of lines) {
        const extracted = extractStepMetadata(line);
        if (!extracted) {
          continue;
        }
        projectPath ??= extracted.projectPath;
        firstUserMessage ??= extracted.firstUserMessage;
        if (projectPath && firstUserMessage) {
          break;
        }
      }
    } catch (error) {
      console.warn('[Antigravity] Failed to read transcript', {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown read error',
      });
      throw error;
    }

    if (!projectPath) {
      return null;
    }

    return {
      sessionId,
      projectPath,
      sessionName: normalizeSessionName(firstUserMessage, UNTITLED_SESSION),
    };
  }

  /**
   * Parses `history.jsonl` once into a `Map<conversationId, metadata>` instead
   * of re-reading and re-scanning the whole (append-only, potentially
   * multi-MB) file for every transcript in a batch. history.jsonl is
   * append-only, so iterating forward and letting a later line overwrite an
   * earlier one for the same conversation id yields the same "most recent
   * entry" result the old newest-first, first-hit scan returned per file.
   */
  private async buildHistoryMetadataMap(): Promise<Map<string, HistoryMetadata>> {
    const map = new Map<string, HistoryMetadata>();
    try {
      const lines = (await readFile(this.historyPath, 'utf8')).split(/\r?\n/);
      // The history can be observed while agy is appending a partial line;
      // iterateJsonlLines skips those.
      for (const parsed of iterateJsonlLines(lines)) {
        const entry = readObjectRecord(parsed);
        const sessionId = readOptionalString(entry?.conversationId);
        if (!sessionId) {
          continue;
        }
        map.set(sessionId, {
          projectPath: readOptionalString(entry?.workspace),
          sessionName: readOptionalString(entry?.display),
        });
      }
    } catch {
      // History is an optional metadata source; transcripts remain authoritative.
    }
    return map;
  }
}
