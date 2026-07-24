import { stat } from 'node:fs/promises';

import { resolveClaudeJsonlPath } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord } from '@/shared/types.js';
import { readFileTail } from '@/shared/utils.js';

/**
 * Server-derived "what is this session doing right now" status for sessions
 * cloudcli did not launch (#21).
 *
 * A bare-terminal `claude` writes the same `~/.claude/projects/*.jsonl` files as
 * cloudcli, so it appears in the unified Conversations list — but cloudcli has
 * no live run for it and would always rank it idle. This module recovers a live
 * status straight from the transcript on disk (mtime recency + last-event
 * inspection) so those sessions rank alongside cloudcli-driven ones. Herdr-style
 * order: plan > blocked > working > idle.
 */
export type SessionLiveStatus = 'plan' | 'blocked' | 'working' | 'idle';

// A transcript touched within this window is treated as an agent that is
// actively writing (streaming assistant text / a rapid tool loop). Kept short so
// a finished turn decays to idle quickly, yet long enough to tolerate the brief
// gaps between successive tool calls without the status flapping.
const WORKING_WINDOW_MS = 15_000;

// An assistant turn that ends on an unanswered *generic* tool_use (a permission
// prompt or a slow tool) still "needs me" for up to this long. Beyond it we
// assume the terminal session was abandoned (closed without answering) and let
// it fall back to idle history. Interaction tools (below) get a longer window.
const AWAITING_INPUT_WINDOW_MS = 5 * 60_000;

// An assistant turn parked on an *interaction* tool — a plan submitted for
// approval (`ExitPlanMode`) or a direct question (`AskUserQuestion`) — is a
// deliberate, indefinite wait on the user, not a slow tool that will resolve on
// its own. A finished plan can sit for a long time before I get back to it, so
// it stays flagged far longer than a generic prompt. Bounded (rather than
// forever) because it also caps how far back resolveSessionLiveStatus reads
// transcripts on every projects fetch — 4h covers a realistic step-away while
// keeping the disk fan-out predictable.
const INTERACTION_INPUT_WINDOW_MS = 4 * 60 * 60_000;

// Tools whose unanswered tool_use marks a deliberate wait on the user. Names are
// matched against the on-disk tool_use `name` (PascalCase in Claude transcripts);
// `exit_plan_mode` is accepted defensively in case the snake_case id ever lands.
const PLAN_TOOL_NAMES = new Set(['ExitPlanMode', 'exit_plan_mode']);
const INTERACTION_TOOL_NAMES = new Set([...PLAN_TOOL_NAMES, 'AskUserQuestion']);

// Initial bytes read from the end of the transcript. A handful of ordinary
// JSONL events fit easily. The final event can be far larger than this, though
// — a big `Write`/`Edit` tool_use embeds the whole file body — so when the
// slice lands entirely inside one oversized last line and parses nothing,
// resolveSessionLiveStatus grows the window (below) rather than miss a
// permission-pending large write.
const LIVE_STATUS_TAIL_BYTES = 128 * 1024;

// Upper bound on the grow-the-window retry. A pathological final event (writing
// a multi-MB file) beyond this is left unclassified rather than slurped whole on
// every projects fetch — an acceptable miss for an extreme edge versus the cost
// of reading megabytes per session.
const LIVE_STATUS_MAX_TAIL_BYTES = 4 * 1024 * 1024;

/** Parses the JSONL tail, skipping blank and (often truncated) unparseable lines. */
function parseTailEvents(tail: string): AnyRecord[] {
  const events: AnyRecord[] = [];
  for (const line of tail.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as AnyRecord);
    } catch {
      // The first slice line is frequently cut mid-record; ignore bad lines.
    }
  }
  return events;
}

/**
 * Name of the `tool_use` the transcript's final assistant turn is parked on with
 * no matching `tool_result` yet — the on-disk proxy for "awaiting the user" — or
 * `null` when the latest turn resolved (or never issued) its tools.
 *
 * Claude does not persist permission / plan-approval prompts to the JSONL (those
 * are live SDK-only events), so an unanswered tool_use is the best available
 * signal that the agent is parked waiting on input rather than still producing
 * output. Plan mode's `ExitPlanMode` is itself a tool_use, so it is covered too.
 * The name lets the caller tell a deliberate interaction wait (plan / question)
 * from a generic permission prompt or slow tool.
 */
function trailingUnansweredToolName(events: AnyRecord[]): string | null {
  if (events.length === 0) {
    return null;
  }

  // Every tool_result anywhere in the tail resolves its originating tool_use.
  const resolvedToolUseIds = new Set<string>();
  for (const event of events) {
    const content = event.message?.role === 'user' ? event.message?.content : null;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content as AnyRecord[]) {
      if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        resolvedToolUseIds.add(part.tool_use_id);
      }
    }
  }

  // Inspect the most recent assistant message: an unanswered tool_use means the
  // turn is parked waiting on the user. When a turn issues several tools, prefer
  // an interaction tool (a plan / question the user must answer) over a generic
  // one so the whole turn is classified by the wait that actually needs a human.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.message?.role !== 'assistant') {
      continue;
    }

    const content = event.message?.content;
    if (!Array.isArray(content)) {
      return null;
    }

    let pendingGenericTool: string | null = null;
    for (const part of content as AnyRecord[]) {
      if (part?.type === 'tool_use' && typeof part.id === 'string' && !resolvedToolUseIds.has(part.id)) {
        const name = typeof part.name === 'string' ? part.name : '';
        if (INTERACTION_TOOL_NAMES.has(name)) {
          return name;
        }
        pendingGenericTool ??= name;
      }
    }

    // The latest assistant turn resolved (or never issued) its tools → not
    // waiting; otherwise it is parked on a generic (non-interaction) tool.
    return pendingGenericTool;
  }

  return null;
}

function classifyFromEvents(events: AnyRecord[], mtimeMs: number, nowMs: number): SessionLiveStatus {
  const ageMs = nowMs - mtimeMs;
  const pendingTool = trailingUnansweredToolName(events);

  if (pendingTool !== null) {
    // A plan submitted for approval / a direct question is a deliberate wait on
    // the user and stays flagged for the long interaction window. A finished
    // plan gets its own status so the UI can present it as a deliverable to
    // review rather than a generic "blocked" prompt.
    if (INTERACTION_TOOL_NAMES.has(pendingTool)) {
      if (ageMs <= INTERACTION_INPUT_WINDOW_MS) {
        return PLAN_TOOL_NAMES.has(pendingTool) ? 'plan' : 'blocked';
      }
    } else if (ageMs <= AWAITING_INPUT_WINDOW_MS) {
      // A generic permission prompt / slow tool: needs attention only while
      // recent, then decays as a likely-abandoned turn.
      return 'blocked';
    }
  }

  // Actively producing output.
  if (ageMs <= WORKING_WINDOW_MS) {
    return 'working';
  }

  // Old history, or a stale/abandoned awaiting-input turn.
  return 'idle';
}

/**
 * Pure classifier: maps a transcript tail plus its mtime to a live status.
 *
 * Exported for unit testing so crafted tails / mtimes can be asserted without
 * touching disk.
 */
export function classifyClaudeLiveStatus(tail: string, mtimeMs: number, nowMs: number): SessionLiveStatus {
  return classifyFromEvents(parseTailEvents(tail), mtimeMs, nowMs);
}

/**
 * Fields needed to locate and classify a session's transcript. Mirrors the
 * columns the sessions DB already stores per row.
 */
export type LiveStatusSource = {
  provider: string;
  sessionId: string;
  jsonlPath: string | null;
  projectPath: string | null;
};

/**
 * Resolves a session's transcript on disk and returns its live status.
 *
 * Best-effort by design: any failure (missing file, unreadable path, unknown
 * provider) yields `'idle'` so a projects/sessions response is never failed over
 * live-status detection. Only Claude transcripts are inspected today; other
 * providers keep `'idle'` rather than risk misreading a different on-disk format.
 */
export async function resolveSessionLiveStatus(
  source: LiveStatusSource,
  nowMs: number = Date.now(),
): Promise<SessionLiveStatus> {
  if (source.provider !== 'claude') {
    return 'idle';
  }

  try {
    const jsonlPath = await resolveClaudeJsonlPath(source.jsonlPath, source.sessionId, source.projectPath);
    if (!jsonlPath) {
      return 'idle';
    }

    const { mtimeMs, size } = await stat(jsonlPath);
    // Fast path: a transcript older than the longest window we still classify
    // (the interaction window, which covers a plan/question parked awaiting the
    // user) is idle history — skip the tail read. Uses the interaction window,
    // not the shorter generic one, so a plan submitted for approval hours ago is
    // still read and ranked rather than silently decaying to idle.
    if (nowMs - mtimeMs > INTERACTION_INPUT_WINDOW_MS) {
      return 'idle';
    }

    // Read the transcript tail, growing the window if the slice fell entirely
    // inside one oversized final event (a large Write/Edit tool_use) and parsed
    // nothing — otherwise a permission-pending large write would be missed and
    // never ranked blocked. Bounded by the file size and a hard cap.
    let windowBytes = LIVE_STATUS_TAIL_BYTES;
    let events = parseTailEvents(await readFileTail(jsonlPath, windowBytes));
    while (events.length === 0 && windowBytes < size && windowBytes < LIVE_STATUS_MAX_TAIL_BYTES) {
      windowBytes = Math.min(windowBytes * 4, LIVE_STATUS_MAX_TAIL_BYTES);
      events = parseTailEvents(await readFileTail(jsonlPath, windowBytes));
    }
    return classifyFromEvents(events, mtimeMs, nowMs);
  } catch {
    return 'idle';
  }
}
