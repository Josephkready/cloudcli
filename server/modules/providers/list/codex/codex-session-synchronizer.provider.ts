import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { shouldExcludeProjectPath } from '@/shared/project-exclude.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyModifiedAfter,
  normalizeSessionName,
  readFileHead,
  readFileTail,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

import { FileFingerprintCache } from '../claude/session-summary-cache.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

type CodexTitleCandidates = {
  firstUserMessage?: string;
  lastAgentMessage?: string;
};

const CODEX_TITLE_SCAN_BYTES = 256 * 1024;

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = path.join(os.homedir(), '.codex');
  private readonly titleCandidatesCache = new FileFingerprintCache<CodexTitleCandidates>();

  /**
   * Scans ~/.codex/sessions and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const files = await findFilesRecursivelyModifiedAfter(
      path.join(this.codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
        ?? sessionsDb.getSessionById(parsed.sessionId);
      if (existingSession) {
        // If session name is untitled and we now have a name, update it
        if (existingSession.custom_name === 'Untitled Codex Session' && parsed.sessionName && parsed.sessionName !== 'Untitled Codex Session') {
          sessionsDb.updateSessionCustomName(existingSession.session_id, parsed.sessionName);
        }
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
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
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
      };
    });

    if (!parsed || parsed.isSubagent) {
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

    // Provenance, not spelling, decides whether a name may be refreshed (#379) —
    // the same rule the database enforces on write, and the same one the Claude
    // synchronizer uses. `'user'` (a deliberate rename) and `'ai'` (a finished
    // title from cloudcli's own worker) are final.
    if (existingSession?.name_source) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName ?? undefined, 'Untitled Codex Session'),
      };
    }

    // Codex's real title is the `thread_name` it publishes into
    // session_index.jsonl, which is what `nameMap` holds. A session started from
    // cloudcli is titled from its first user message and left unsourced, so
    // without this a later thread_name could never be adopted.
    //
    // Only that title may overwrite an existing name. The other two sources below
    // are message text — the first prompt, and the *last agent message*, which
    // changes constantly — so re-deriving them on every scan would rewrite the
    // sidebar as the conversation moves. They stay reserved for a row with no
    // name worth keeping yet.
    const discoveredTitle = nameMap.get(parsed.sessionId);
    const hasKeepableName = Boolean(existingSessionName)
      && existingSessionName !== 'Untitled Codex Session';

    if (hasKeepableName) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(
          discoveredTitle ?? existingSessionName ?? undefined,
          'Untitled Codex Session',
        ),
      };
    }

    // Sessions started by sending a message from cloudcli carry a distinct
    // app-allocated session_id mapped to the provider id. For these we title the
    // conversation from the first user message the user typed, instead of the
    // generic "Untitled Codex Session" placeholder. Sessions discovered purely
    // by indexing (session_id === provider_session_id) keep the existing
    // thread_name/last-agent-message setup below.
    const isAppCreated =
      existingSession != null &&
      existingSession.provider_session_id != null &&
      existingSession.session_id !== existingSession.provider_session_id;

    let sessionName = isAppCreated ? undefined : nameMap.get(parsed.sessionId);
    const titleCandidates = (isAppCreated || !sessionName)
      ? await this.extractTitleCandidates(filePath)
      : {};
    if (isAppCreated) {
      sessionName = titleCandidates.firstUserMessage;
    }
    if (!sessionName) {
      sessionName = nameMap.get(parsed.sessionId);
    }
    if (!sessionName) {
      sessionName = titleCandidates.lastAgentMessage;
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  /**
   * Returns the first user message text in a Codex transcript, used to title
   * app-created sessions from the prompt the user sent from cloudcli.
   *
   * Reads the `event_msg`/`user_message` payload rather than the raw
   * `response_item` user turn so injected `<environment_context>` boilerplate is
   * never mistaken for the user's prompt.
  */
  private extractFirstUserMessageFromStart(content: string): string | undefined {
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const data = parsed as Record<string, unknown>;
      const eventType = typeof data.type === 'string' ? data.type : undefined;
      const payload = data.payload as Record<string, unknown> | undefined;
      const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
      const message = typeof payload?.message === 'string' ? payload.message : undefined;

      if (eventType === 'event_msg' && payloadType === 'user_message' && message?.trim()) {
        return message;
      }
    }
    return undefined;
  }

  private extractLastAgentMessageFromEnd(content: string): string | undefined {
    const lines = content.split(/\r?\n/);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const data = parsed as Record<string, unknown>;
      const eventType = typeof data.type === 'string' ? data.type : undefined;
      const payload = data.payload as Record<string, unknown> | undefined;
      const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
      const lastAgentMessage = typeof payload?.last_agent_message === 'string'
        ? payload.last_agent_message
        : undefined;

      if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
        return lastAgentMessage;
      }
    }
    return undefined;
  }

  private async extractTitleCandidates(filePath: string): Promise<CodexTitleCandidates> {
    try {
      const fileStat = await stat(filePath);
      const fingerprint = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
      const cached = this.titleCandidatesCache.get(filePath, fingerprint);
      if (cached) {
        return cached;
      }

      const head = await readFileHead(filePath, CODEX_TITLE_SCAN_BYTES);
      const tail = fileStat.size <= CODEX_TITLE_SCAN_BYTES
        ? head
        : await readFileTail(filePath, CODEX_TITLE_SCAN_BYTES);
      const candidates = {
        firstUserMessage: this.extractFirstUserMessageFromStart(head),
        lastAgentMessage: this.extractLastAgentMessageFromEnd(tail),
      };
      this.titleCandidatesCache.set(filePath, fingerprint, candidates);
      return candidates;
    } catch (error) {
      console.warn('[CodexSynchronizer] Could not extract title candidates', {
        file: path.basename(filePath),
        errorCode: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN',
      });
      return {};
    }
  }
}
