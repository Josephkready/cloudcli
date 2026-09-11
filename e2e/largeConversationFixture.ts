import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Writes a deterministic, 500+-row conversation directly into a running e2e
 * worker's `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, the same
 * transcript format and directory convention `bench/seed.ts` uses (see that
 * file's `buildTranscriptRows`/`encodeProjectDir`/`seedFixture`). Duplicated
 * in miniature here rather than imported: `bench/` and `e2e/` are separate
 * tsconfig projects (`npm run typecheck` builds each independently), and this
 * only needs the encoding convention and row shape, not the multi-project
 * fixture machinery bench builds around them.
 *
 * The server's session synchronizer discovers new transcript files on the
 * next sessions-list fetch for an already-registered project (cloudcli#483
 * phase 2 relies on this the same way `bench/`'s own README documents) — no
 * server restart or extra registration call is needed, just: write the file,
 * stamp its mtime near "now" so the incremental scanner's `last_scanned_at`
 * cursor doesn't skip it, then navigate.
 */

/** Mirrors `bench/seed.ts`'s `encodeProjectDir` — Claude's own cwd-to-dirname convention. */
function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

/** A small, seeded 32-bit hash (FNV-1a), run four times with different salts
 * to produce enough bits for a UUID-shaped string. Only needs to be
 * deterministic and collision-free across this file's own seed strings, not
 * cryptographically sound. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function uuidFrom(seed: string): string {
  const parts = [0, 1, 2, 3].map((salt) => fnv1a32(`${salt}:${seed}`).toString(16).padStart(8, '0'));
  const hex = parts.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface LargeConversationHandles {
  sessionId: string;
  /** Total messages that will actually render (control frames are excluded). */
  messageCount: number;
  /** Text unique to the very first (oldest) message — off-screen until "Load all"/search. */
  firstMessageText: string;
  /** Text unique to the very last (newest) message — visible immediately (auto-follow lands here). */
  lastMessageText: string;
  /** Text of the message immediately after the mermaid one, used as a stable resize-anchor reference. */
  afterMermaidMessageText: string;
}

/**
 * Seeds `rowCount` user/assistant turns into `projectPath`'s transcript
 * directory under `home`. One turn near the end carries a Mermaid fence (its
 * diagram renders asynchronously, after the SVG layout finishes — the case
 * `@tanstack/react-virtual`'s dynamic measurement has to absorb without
 * shifting whatever the reader is currently looking at).
 */
export function seedLargeConversation(
  home: string,
  projectPath: string,
  rowCount = 520,
): LargeConversationHandles {
  // Unique per call, not just per project: several tests in the same spec
  // file share one worker's project, and each needs its own untouched session
  // — reusing one id would let a real chat turn one test sends (which really
  // does append to the transcript server-side) bleed into the next test's
  // seed, shifting message indices out from under it.
  const sessionId = uuidFrom(`large-conversation-${projectPath}-${Date.now()}-${Math.random()}`);
  const transcriptDir = path.join(home, '.claude', 'projects', encodeProjectDir(projectPath));
  mkdirSync(transcriptDir, { recursive: true });

  // The initial session-open fetch loads only the most recent
  // `MESSAGES_PER_PAGE` (20) raw transcript rows (`useChatSessionState.ts`);
  // older content needs a scroll-triggered page load to reach. Keeping the
  // mermaid message within the last handful of loop iterations (each of which
  // emits 1-2 raw rows) guarantees it lands inside that first fetch without a
  // test needing to drive pagination first.
  const mermaidIndex = rowCount - 6;
  const baseTimeMs = Date.UTC(2026, 0, 1);
  const lines: string[] = [];
  let clock = baseTimeMs;

  const push = (row: Record<string, unknown>) => {
    clock += 1_500;
    lines.push(JSON.stringify({
      sessionId,
      cwd: projectPath,
      timestamp: new Date(clock).toISOString(),
      uuid: uuidFrom(`${sessionId}-${lines.length}`),
      version: '2.0.0',
      ...row,
    }));
  };

  const messageText = (index: number): string => `virtualized-fixture message #${index} of ${rowCount}`;

  for (let i = 0; i < rowCount; i++) {
    if (i === mermaidIndex) {
      push({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: `${messageText(i)}\n\n\`\`\`mermaid\nflowchart TD\n  A[Start] --> B{Check}\n  B -->|yes| C[Do the thing]\n  B -->|no| D[Skip it]\n  C --> E[End]\n  D --> E\n\`\`\`\n`,
          }],
        },
      });
      continue;
    }

    if (i % 5 === 0) {
      const toolId = `toolu_${uuidFrom(`${sessionId}-tool-${i}`).replace(/-/g, '').slice(0, 20)}`;
      push({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: messageText(i) },
            { type: 'tool_use', id: toolId, name: 'Read', input: { file_path: `${projectPath}/src/index.ts`, limit: 20 } },
          ],
        },
      });
      push({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolId, content: 'export const value = 1;\n' }],
        },
        toolUseResult: { filePath: `${projectPath}/src/index.ts` },
      });
      continue;
    }

    push({
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: messageText(i) }],
      },
    });
  }

  const contents = `${lines.join('\n')}\n`;
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, contents);
  const now = new Date();
  utimesSync(transcriptPath, now, now);

  return {
    sessionId,
    messageCount: rowCount,
    firstMessageText: messageText(0),
    lastMessageText: messageText(rowCount - 1),
    afterMermaidMessageText: messageText(mermaidIndex + 1),
  };
}
