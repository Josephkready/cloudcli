import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { shouldExcludeProjectPath } from '@/shared/project-exclude.js';
import {
  findFilesRecursivelyModifiedAfter,
  normalizeSessionName,
  readFileTimestamps,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const PROVIDER = 'antigravity' as const;
const UNTITLED_SESSION = 'Untitled Antigravity Session';

type ParsedAntigravitySession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

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
    let processed = 0;

    for (const filePath of files) {
      if (await this.synchronizeFile(filePath)) {
        processed += 1;
      }
    }
    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (path.basename(filePath) !== 'transcript.jsonl') {
      return null;
    }

    const parsed = await this.processTranscriptFile(filePath);
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

  private async processTranscriptFile(filePath: string): Promise<ParsedAntigravitySession | null> {
    const sessionId = getAntigravitySessionIdFromTranscriptPath(filePath);
    if (!sessionId) {
      return null;
    }

    const historyMetadata = await this.readHistoryMetadata(sessionId);
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
    } catch {
      return null;
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

  private async readHistoryMetadata(
    sessionId: string,
  ): Promise<{ projectPath?: string; sessionName?: string } | null> {
    try {
      const lines = (await readFile(this.historyPath, 'utf8')).split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }
        const entry = readObjectRecord(JSON.parse(line));
        if (readOptionalString(entry?.conversationId) !== sessionId) {
          continue;
        }
        return {
          projectPath: readOptionalString(entry?.workspace),
          sessionName: readOptionalString(entry?.display),
        };
      }
    } catch {
      // History is an optional metadata source; transcripts remain authoritative.
    }
    return null;
  }
}
