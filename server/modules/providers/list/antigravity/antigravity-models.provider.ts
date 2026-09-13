import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  buildProviderCliEnv,
  resolveProviderCliExecutable,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

const execFileAsync = promisify(execFile);
const MODELS_TIMEOUT_MS = 20_000;

// Reasoning tiers `agy --effort` accepts, low→high. `agy models` encodes the
// tier as a slug suffix (`gemini-3.8-flash-high`); we split it back out so the
// picker offers one model selector plus a separate effort selector, and the
// tier is sent as `--effort`, mirroring `agy`'s own two-flag interface.
export const ANTIGRAVITY_EFFORT_TIERS = ['low', 'medium', 'high'] as const;
export type AntigravityEffortTier = (typeof ANTIGRAVITY_EFFORT_TIERS)[number];

const EFFORT_SUFFIX = new RegExp(`-(${ANTIGRAVITY_EFFORT_TIERS.join('|')})$`);
const EFFORT_LABEL_SUFFIX = /\s*\((?:high|medium|low)\)\s*$/i;

/**
 * Split a raw `agy models` slug into its base model family and reasoning tier.
 *
 *   `gemini-3.8-flash-high`     -> { base: 'gemini-3.8-flash', effort: 'high' }
 *   `claude-sonnet-4-6`         -> { base: 'claude-sonnet-4-6', effort: null }
 *   `claude-opus-4-6-thinking`  -> { base: 'claude-opus-4-6-thinking', effort: null }
 *
 * The base is what we pass to `agy --model`; the tier (if any) becomes
 * `agy --effort`. Reconstructing `${base}-${effort}` reproduces the original
 * slug for every tiered model, which the round-trip test asserts.
 */
export function splitAntigravitySlug(slug: string): { base: string; effort: AntigravityEffortTier | null } {
  const match = EFFORT_SUFFIX.exec(slug);
  if (match) {
    return { base: slug.slice(0, match.index), effort: match[1] as AntigravityEffortTier };
  }
  return { base: slug, effort: null };
}

/** Pick a sensible default tier: prefer `medium`, else `high`, else the lowest offered. */
function defaultEffortTier(tiers: readonly AntigravityEffortTier[]): AntigravityEffortTier {
  if (tiers.includes('medium')) return 'medium';
  if (tiers.includes('high')) return 'high';
  return tiers[0];
}

/**
 * Fold raw `agy models` rows (`<slug>\t<label>`) into base-model options, each
 * carrying the effort tiers it actually supports. A model with no tiered slug
 * (Claude on Antigravity) gets no `effort` field, so the picker hides the effort
 * selector for it — the same convention Claude's `haiku` uses.
 */
function groupAntigravityModels(rows: readonly { value: string; label: string }[]): ProviderModelsDefinition {
  const order: string[] = [];
  const byBase = new Map<string, { label: string; efforts: Set<AntigravityEffortTier> }>();

  for (const row of rows) {
    const { base, effort } = splitAntigravitySlug(row.value);
    let entry = byBase.get(base);
    if (!entry) {
      entry = { label: row.label.replace(EFFORT_LABEL_SUFFIX, '').trim() || base, efforts: new Set() };
      byBase.set(base, entry);
      order.push(base);
    }
    if (effort) {
      entry.efforts.add(effort);
    }
  }

  const options: ProviderModelOption[] = order.map((base) => {
    const entry = byBase.get(base)!;
    const tiers = ANTIGRAVITY_EFFORT_TIERS.filter((tier) => entry.efforts.has(tier));
    const option: ProviderModelOption = {
      value: base,
      label: entry.label,
      description: 'Antigravity CLI model',
    };
    if (tiers.length > 0) {
      option.effort = {
        default: defaultEffortTier(tiers),
        values: tiers.map((value) => ({ value })),
      };
    }
    return option;
  });

  if (options.length === 0) {
    return ANTIGRAVITY_FALLBACK_MODELS;
  }

  return { OPTIONS: options, DEFAULT: options[0].value };
}

// Used only when `agy models` fails or times out. Keep in step with the live
// `agy models` catalog: gemini-3.5-flash-* were removed upstream, and the tiers
// below must match what `agy --effort` accepts per family (3.1-pro has no
// medium; Claude models take no effort; gpt-oss-120b is medium only).
export const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = groupAntigravityModels([
  { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { value: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
  { value: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
  { value: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
  { value: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
  { value: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)' },
  { value: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)' },
  { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
  { value: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
]);

export function parseAntigravityModelsStdout(stdout: string): ProviderModelsDefinition {
  const seen = new Set<string>();
  const rows = stdout
    .split(/\r?\n/)
    // `agy models` prints one model per line. Current builds emit
    // `<slug>\t<Human label>` (e.g. `gemini-3.8-flash-high\tGemini 3.8 Flash
    // (High)`); older builds printed just `<slug>`. Only the slug is a valid
    // `agy` argument, so take the first tab-delimited field as the value —
    // passing the whole line (label included) is what `agy` rejected as
    // "Invalid model" (#492). Fall back to the slug for the label when no label
    // column is present.
    .map((line) => {
      const [rawValue, rawLabel] = line.split('\t');
      const value = (rawValue ?? '').trim();
      const label = (rawLabel ?? '').trim();
      return { value, label: label.length > 0 ? label : value };
    })
    .filter((row) => row.value.length > 0 && !seen.has(row.value) && (seen.add(row.value), true));

  return groupAntigravityModels(rows);
}

export class AntigravityProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const { stdout } = await execFileAsync(
        resolveProviderCliExecutable('ANTIGRAVITY_CLI_PATH', 'agy'),
        ['models'],
        {
        encoding: 'utf8',
        env: buildProviderCliEnv(),
        timeout: MODELS_TIMEOUT_MS,
        },
      );
      return parseAntigravityModelsStdout(stdout);
    } catch {
      return ANTIGRAVITY_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('antigravity', input);
  }
}
