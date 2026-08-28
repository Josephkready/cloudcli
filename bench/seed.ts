/**
 * Fixture generator for the end-to-end performance benchmark.
 *
 * Builds a throwaway HOME that looks like a real cloudcli user's machine:
 * workspace folders on disk, a `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
 * transcript per conversation, and a `~/.claude/history.jsonl` name map. The
 * server's own session synchronizer discovers all of it on boot — nothing here
 * reaches into the database, so the fixture exercises the same indexing path a
 * real library does.
 *
 * Two properties are load-bearing:
 *
 * 1. **Deterministic.** Everything derives from a seeded PRNG and a fixed base
 *    timestamp, so two runs at different commits measure byte-identical data.
 *    A benchmark whose fixture drifts cannot attribute a delta to a code change.
 *
 * 2. **Skewed, not uniform.** Real libraries have one or two enormous
 *    conversations and a long tail of short ones, and the expensive paths only
 *    show up on the former. A fixture of uniformly-average sessions would report
 *    a flattering number for exactly the case users complain about.
 */

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FixtureManifest } from './types.js';

/** Shape of one conversation to generate. */
type SessionPlan = {
  id: string;
  title: string;
  /** Number of user→assistant exchanges; each expands to several JSONL rows. */
  turns: number;
};

type ProjectPlan = {
  name: string;
  isGitRepo: boolean;
  sessions: SessionPlan[];
};

/** Named fixture sizes. `standard` is what `npm run bench` uses. */
export type ProfileName = 'small' | 'standard' | 'large';

type Profile = {
  projects: number;
  /** Conversations in the primary project (the one the flows work in). */
  primarySessions: number;
  /** Conversations in every other project. */
  secondarySessions: number;
  /** Turns in the deliberately-huge transcript. */
  largeTurns: number;
  /** Turns in a typical transcript. */
  typicalTurns: number;
};

const PROFILES: Record<ProfileName, Profile> = {
  // Fast to generate and fast to run — for iterating on the harness itself.
  small: { projects: 2, primarySessions: 6, secondarySessions: 3, largeTurns: 120, typicalTurns: 12 },
  // The default. Sized so a cold session-switch is measurably slower than a warm
  // one on a developer laptop, without the fixture taking a minute to write.
  standard: { projects: 6, primarySessions: 24, secondarySessions: 6, largeTurns: 900, typicalTurns: 24 },
  // Stress profile for confirming a fix holds at the top end of real libraries.
  large: { projects: 12, primarySessions: 60, secondarySessions: 12, largeTurns: 3000, typicalTurns: 40 },
};

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over `Math.random()` because the fixture must be reproducible across
 * processes and across commits; chosen over a hash-based scheme because the
 * fixture only needs plausible variety, not cryptographic quality.
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic UUIDv4-shaped id.
 *
 * Session ids must match `/[0-9a-f-]{36}/` because the client's `/session/:id`
 * route and several server-side parsers expect that shape, but they must not be
 * random — see the determinism note above.
 */
function deterministicUuid(random: () => number): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let index = 0; index < 36; index++) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      out += '-';
    } else if (index === 14) {
      out += '4';
    } else if (index === 19) {
      out += hex[(Math.floor(random() * 4) + 8) % 16];
    } else {
      out += hex[Math.floor(random() * 16)];
    }
  }
  return out;
}

const WORD_POOL = [
  'render', 'session', 'transcript', 'websocket', 'cache', 'index', 'query', 'payload',
  'handler', 'reducer', 'selector', 'boundary', 'stream', 'commit', 'migration', 'schema',
  'worker', 'listener', 'sidebar', 'composer', 'provider', 'fixture', 'threshold', 'budget',
];

/** A sentence of plausible prose, sized in words. */
function sentence(random: () => number, words: number): string {
  const parts: string[] = [];
  for (let index = 0; index < words; index++) {
    parts.push(WORD_POOL[Math.floor(random() * WORD_POOL.length)]);
  }
  const text = parts.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** A paragraph of prose, sized in sentences. */
function paragraph(random: () => number, sentences: number): string {
  const parts: string[] = [];
  for (let index = 0; index < sentences; index++) {
    parts.push(sentence(random, 6 + Math.floor(random() * 10)));
  }
  return parts.join(' ');
}

/**
 * A fenced code block.
 *
 * Present on purpose: assistant replies in this app are rendered through
 * react-markdown plus a syntax highlighter, which is the single most expensive
 * thing the transcript does per message. A fixture of plain prose would make
 * transcript rendering look far cheaper than it is.
 */
function codeBlock(random: () => number, lines: number): string {
  const body: string[] = [];
  for (let index = 0; index < lines; index++) {
    const name = WORD_POOL[Math.floor(random() * WORD_POOL.length)];
    body.push(`  const ${name}${index} = await resolve${name.charAt(0).toUpperCase()}${name.slice(1)}(${index});`);
  }
  return ['```ts', 'export async function run() {', ...body, '  return true;', '}', '```'].join('\n');
}

/**
 * Base timestamp written *inside* the transcripts — fixed, so the bytes on disk
 * are identical between runs.
 *
 * File mtimes are deliberately NOT derived from this; see the stamping in
 * `seedFixture`.
 */
const BASE_TIME_MS = Date.UTC(2026, 0, 15, 9, 0, 0);

/**
 * Builds the JSONL rows for one conversation.
 *
 * Row shapes mirror what Claude Code actually appends: a `user` row with an
 * array `content`, `assistant` rows carrying `text` / `tool_use` parts, and
 * `tool_result` parts coming back on a `user` row. The provider's normalizer
 * branches on exactly these, so a simplified shape would skip the parsing work
 * the benchmark is meant to measure.
 */
function buildTranscriptRows(
  session: SessionPlan,
  projectPath: string,
  random: () => number,
): string[] {
  const rows: string[] = [];
  let clock = BASE_TIME_MS;

  const push = (row: Record<string, unknown>) => {
    clock += 1_000 + Math.floor(random() * 4_000);
    rows.push(JSON.stringify({
      sessionId: session.id,
      cwd: projectPath,
      timestamp: new Date(clock).toISOString(),
      uuid: deterministicUuid(random),
      version: '2.0.0',
      ...row,
    }));
  };

  for (let turn = 0; turn < session.turns; turn++) {
    push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: turn === 0 ? session.title : sentence(random, 8 + Math.floor(random() * 14)) }],
      },
    });

    // Roughly two turns in five involve a tool round-trip, which is what a real
    // coding session looks like and what makes the transcript rows outnumber the
    // rendered messages.
    if (random() < 0.4) {
      const toolId = `toolu_${deterministicUuid(random).replace(/-/g, '').slice(0, 20)}`;
      push({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: sentence(random, 8) },
            { type: 'tool_use', id: toolId, name: 'Read', input: { file_path: `${projectPath}/src/index.ts`, limit: 80 } },
          ],
        },
      });
      push({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolId, content: codeBlock(random, 12) }],
        },
        toolUseResult: { filePath: `${projectPath}/src/index.ts` },
      });
    }

    const parts: Array<Record<string, unknown>> = [];
    if (random() < 0.25) {
      parts.push({ type: 'thinking', thinking: paragraph(random, 2) });
    }
    parts.push({
      type: 'text',
      text: random() < 0.35
        ? `${paragraph(random, 2)}\n\n${codeBlock(random, 6 + Math.floor(random() * 10))}\n\n${paragraph(random, 1)}`
        : paragraph(random, 1 + Math.floor(random() * 3)),
    });
    push({ type: 'assistant', message: { role: 'assistant', content: parts } });
  }

  // Closing marker. The flows need a predicate that says "the transcript *of
  // this session* is on screen", and message count cannot provide one: the
  // client pages at 20 messages, so a 900-turn conversation and a 24-turn one
  // both render exactly 20 rows. Since every session's last message is the one
  // guaranteed to be in that page, stamping the session id into it gives each
  // conversation a unique, always-visible signature.
  push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${sessionMarker(session.id)} ${sentence(random, 6)}` }] },
  });

  return rows;
}

/** The unique string the seeder writes into each session's final message. */
export function sessionMarker(sessionId: string): string {
  return `bench-marker-${sessionId.slice(0, 8)}`;
}

/** Claude encodes a project's absolute cwd into a flat directory name. */
export function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Writes the whole fixture under `home` and returns a manifest describing it.
 *
 * `home` is expected to already exist and to be disposable — the caller owns its
 * lifecycle (see `bench/server.ts`, which creates it under `/var/tmp` because
 * the workspace-path validator rejects `/tmp`).
 */
export function seedFixture(options: {
  home: string;
  profile?: ProfileName;
  seed?: number;
}): FixtureManifest {
  const profileName: ProfileName = options.profile ?? 'standard';
  const profile = PROFILES[profileName];
  const seed = options.seed ?? 20260815;
  const random = createRandom(seed);

  const claudeProjectsRoot = path.join(options.home, '.claude', 'projects');
  mkdirSync(claudeProjectsRoot, { recursive: true });

  const plans: ProjectPlan[] = [];
  for (let projectIndex = 0; projectIndex < profile.projects; projectIndex++) {
    const isPrimary = projectIndex === 0;
    const sessionCount = isPrimary ? profile.primarySessions : profile.secondarySessions;
    const sessions: SessionPlan[] = [];

    for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex++) {
      // Only the primary project carries the outliers: the flows navigate there,
      // and putting a 900-turn transcript in every project would inflate seeding
      // time without adding a case the benchmark reads.
      const turns = isPrimary && sessionIndex === 0
        ? profile.largeTurns
        : isPrimary && sessionIndex === 1
          ? Math.round(profile.largeTurns / 3)
          : profile.typicalTurns + Math.floor(random() * 8);

      sessions.push({
        id: deterministicUuid(random),
        title: `${sentence(random, 4).replace(/\.$/, '')} (${turns} turns)`,
        turns,
      });
    }

    plans.push({
      name: isPrimary ? 'bench-primary' : `bench-workspace-${projectIndex}`,
      // Alternating rather than all-true: `isGitRepositoryRoot` and
      // `isGitWorktree` both stat per project on the `/api/projects` path, and a
      // fixture where every stat hits would hide the miss cost.
      isGitRepo: projectIndex % 2 === 0,
      sessions,
    });
  }

  // One clock reading for the whole fixture, so every transcript's mtime is
  // placed on the same timeline no matter how long writing takes.
  const seedStartedAtMs = Date.now();
  const historyLines: string[] = [];
  const manifestProjects: FixtureManifest['projects'] = [];
  let totalRows = 0;
  let totalBytes = 0;

  for (const plan of plans) {
    const projectPath = path.join(options.home, plan.name);
    mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    writeFileSync(
      path.join(projectPath, 'package.json'),
      `${JSON.stringify({ name: plan.name, version: '1.0.0', private: true }, null, 2)}\n`,
    );
    if (plan.isGitRepo) {
      // `isGitRepositoryRoot` only stats for `.git`; an empty directory is enough
      // to make the probe hit without paying to init a real repository.
      mkdirSync(path.join(projectPath, '.git'), { recursive: true });
    }

    const transcriptDir = path.join(claudeProjectsRoot, encodeProjectDir(projectPath));
    mkdirSync(transcriptDir, { recursive: true });

    const manifestSessions: FixtureManifest['projects'][number]['sessions'] = [];
    for (const session of plan.sessions) {
      const rows = buildTranscriptRows(session, projectPath, random);
      const contents = `${rows.join('\n')}\n`;
      const transcriptPath = path.join(transcriptDir, `${session.id}.jsonl`);
      writeFileSync(transcriptPath, contents);

      // Sidebar order comes from each transcript's mtime, so leaving them at
      // whatever the loop produced would let a flow that clicks "the sixth
      // conversation" target a different session between runs. Stamping them an
      // hour apart, newest first, pins both the ordering and which sessions land
      // on page one.
      //
      // Anchored to *now* rather than to `BASE_TIME_MS`: the server indexes
      // transcripts incrementally, skipping anything older than
      // `scan_state.last_scanned_at`, so a fixture dated months in the past is
      // one advanced cursor away from being invisible — which is exactly how a
      // run failed with "0 of 6 seeded projects were indexed". Relative
      // ordering is what the flows depend on, and that is preserved.
      const stamp = new Date(seedStartedAtMs - (manifestSessions.length + 1) * 3_600_000);
      utimesSync(transcriptPath, stamp, stamp);

      historyLines.push(JSON.stringify({ sessionId: session.id, display: session.title }));

      manifestSessions.push({
        id: session.id,
        title: session.title,
        rows: rows.length,
        bytes: Buffer.byteLength(contents),
      });
      totalRows += rows.length;
      totalBytes += Buffer.byteLength(contents);
    }

    manifestProjects.push({
      name: plan.name,
      path: projectPath,
      isGitRepo: plan.isGitRepo,
      sessions: manifestSessions,
    });
  }

  writeFileSync(path.join(options.home, '.claude', 'history.jsonl'), `${historyLines.join('\n')}\n`);

  const primary = manifestProjects[0];
  return {
    home: options.home,
    seed,
    profile: profileName,
    projects: manifestProjects,
    totals: {
      projects: manifestProjects.length,
      sessions: manifestProjects.reduce((sum, project) => sum + project.sessions.length, 0),
      rows: totalRows,
      bytes: totalBytes,
    },
    targets: {
      largeSessionId: primary.sessions[0].id,
      // A typical-length conversation, chosen a few rows down the list so the
      // click is a real list interaction, but comfortably inside the sidebar's
      // 20-row first page so the flow never has to paginate to reach it.
      typicalSessionId: primary.sessions[Math.min(6, primary.sessions.length - 1)].id,
      primaryProjectPath: primary.path,
    },
  };
}

export { PROFILES };
