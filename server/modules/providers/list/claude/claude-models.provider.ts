import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

// Mirrors `supportedModels()` on the Claude Code CLI this app spawns. The live
// lookup stays disabled (see ClaudeProviderModels.getSupportedModels), so this
// list is what the model picker actually renders — and `resolveClaudeEffort`
// gates the effort sent to the CLI against each entry's `effort.values`, so a
// missing tier here silently drops the user's effort choice. Re-check against
// `claude`'s own catalog whenever Anthropic ships a model generation.
export const CLAUDE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the Claude Code default model (currently Opus 5 with 1M context)',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable',
      description: 'Fable 5 · Most capable for your hardest and longest-running tasks · Uses your limits ~2× faster than Opus',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: "sonnet",
      label: "Sonnet",
      description: "Sonnet 5 · Efficient for routine tasks · $3/$15 per Mtok",
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Sonnet 5 for long sessions · $3/$15 per Mtok',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Opus 5 · Best for everyday, complex tasks · ~2× usage vs Sonnet',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok',
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

/**
 * Claude Code stamps turns it fabricates locally — API-error notices, aborted
 * turns, session-limit messages — with the placeholder model `<synthetic>`
 * rather than a model id. It is a sentinel, not a name: no real Claude model id
 * is wrapped in angle brackets (the catalog uses bare slugs and square-bracket
 * context suffixes like `opus[1m]`), and `<`/`>` are shell metacharacters that
 * would never appear in a value destined for `--model`.
 *
 * So the guard rejects the *shape* rather than the one literal we have seen.
 * `<synthetic>` is simply the placeholder Claude ships today; `<none>` or
 * `<unknown>` tomorrow would be the same bug, and a shape check absorbs it. The
 * inverse risk — swallowing a legitimate angle-bracketed model id — is not a
 * real one, because no such id exists or can exist for a CLI flag.
 *
 * A leading `<` plus any later `>` is enough: requiring the value to *end* in
 * `>` would let a garbled placeholder that picked up trailing text through as a
 * real model, which is the very failure this guard exists to stop. Values that
 * merely contain angle brackets (`a<b>`) or never close them (`<opus`) are left
 * alone, so the check only fires on something leading with a bracketed token.
 */
export const isPlaceholderModelValue = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.includes('>');
};

/**
 * Maps any model identifier a transcript can carry onto a catalog slug the model
 * picker can match, or null when it names no model we offer. A transcript names
 * the model three different ways depending on the source:
 *   - a bare catalog slug in a `<model>` tag (`opus[1m]`),
 *   - the API model id on an assistant turn (`claude-opus-4-8`, `claude-sonnet-5`),
 *   - the display name in `/model` command stdout (`Opus 5 (1M context)`).
 * All three must resolve to the same slug, otherwise the picker highlights
 * nothing and `/models` prints a string that matches no option (#461, #462).
 *
 * API ids do not encode the 1M-context choice, so they resolve to the base
 * family; only a value that actually says 1M (a display name or a `[1m]` suffix)
 * yields the `[1m]` variant. Exported for tests.
 */
export const normalizeToClaudeModelSlug = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed || isPlaceholderModelValue(trimmed)) {
    return null;
  }

  // An exact catalog slug (incl. `default` and the `[1m]` variants) wins as-is.
  const direct = findClaudeModelOption(trimmed);
  if (direct) {
    return direct.value;
  }

  const lower = trimmed.toLowerCase();
  const family = (['opus', 'sonnet', 'haiku', 'fable'] as const).find((name) => lower.includes(name));
  if (!family) {
    return null;
  }

  // Prefer the 1M variant only when the value says so AND the catalog offers it
  // (opus/sonnet do, haiku/fable do not), else fall back to the base family.
  const wants1m = lower.includes('(1m context)') || lower.includes('[1m]');
  return (
    (wants1m ? findClaudeModelOption(`${family}[1m]`)?.value : null)
    ?? findClaudeModelOption(family)?.value
    ?? null
  );
};

/** Returns the catalog slug for a usable model id, else null. */
const acceptModelValue = (value: string | null | undefined): string | null =>
  normalizeToClaudeModelSlug(value);

const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  return acceptModelValue(event.model) ?? acceptModelValue(event.message?.model);
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    // Capture only the model name, stopping at the first trailing clause. The old
    // end-anchored `(.+?)\.?$` swallowed the whole sentence ("Opus 5 and saved as
    // your default...") (#462); the boundary also keeps the multi-line "settings
    // pins Opus 5 (1M context)" note from mislabelling a base-model switch as 1M.
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)(?:\s+and\s+saved\b|\.(?:\s|$)|$)/i
      .exec(cleanedStdout);
    // Normalized to a catalog slug (or null); a placeholder or unknown capture
    // must not shadow a real <model> tag further down.
    const stdoutModel = acceptModelValue(changedModel?.[1]);
    if (stdoutModel) {
      return stdoutModel;
    }
  }

  return acceptModelValue(extractTaggedContent(content, 'model'));
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

/**
 * Resolves the model a Claude session is running on from its raw JSONL
 * transcript. Scans newest-first, so the answer is the most recent turn that
 * names a usable model — placeholder-stamped turns (see isPlaceholderModelValue)
 * are skipped and the scan keeps walking back to the last real one. Returns null
 * when the transcript names no usable model at all, which the caller turns into
 * the provider default.
 *
 * Exported for tests: this is the whole of the resolution logic, with no fs or
 * database in the way.
 */
export const resolveClaudeSessionModelFromTranscript = (
  sessionId: string,
  transcript: string,
): string | null => {
  const lines = transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return model;
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const model = resolveClaudeSessionModelFromTranscript(sessionId, content);
  return model ? { model } : null;
};

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // claude creates a new jsonl file as a separate session for this request.
    // As a result, it lists the workspace where this is invoked when it shouldn't.
    //
    // Disabled for now:
    // const queryInstance = query({
    //   prompt: 'Get supported models',
    //   options: buildClaudeQueryOptions(),
    // });
    // const supportedModels = await queryInstance.supportedModels();
    // queryInstance.close();
    // return buildClaudeModelsDefinition(supportedModels);
    return CLAUDE_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const row = sessionsDb.getSessionById(sessionId);
      const jsonlPath = row?.jsonl_path;
      // Each transcript event is stamped with the PROVIDER session id, so the guard
      // in resolveClaudeSessionModelFromTranscript must compare against that id, not
      // the app session id we were handed. For a session created inside cloudcli the
      // two differ, and comparing the app id rejected every event and forced
      // 'default' for the picker (#461). A session discovered from disk has no
      // distinct provider id recorded yet, so fall back to the app id — which for
      // those sessions already equals the id written into the transcript.
      const transcriptSessionId = row?.provider_session_id ?? sessionId;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(transcriptSessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('claude', input);
  }
}
