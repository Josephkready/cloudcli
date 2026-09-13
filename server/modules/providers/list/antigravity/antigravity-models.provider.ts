import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
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

export const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = {
  // Used only when `agy models` fails or times out. Keep in step with the live
  // `agy models` catalog: gemini-3.5-flash-* were removed upstream and offering
  // them here handed `agy --model` a name it rejects as "Invalid model" (#492).
  OPTIONS: [
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low',
    'gemini-3.7-flash-high',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-low',
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-low',
    'gemini-3.1-pro-high',
    'gemini-3.1-pro-low',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
    'gpt-oss-120b-medium',
  ].map((model) => ({
    value: model,
    label: model,
    description: 'Antigravity CLI model',
  })),
  DEFAULT: 'gemini-3.8-flash-medium',
};

export function parseAntigravityModelsStdout(stdout: string): ProviderModelsDefinition {
  const seen = new Set<string>();
  const models = stdout
    .split(/\r?\n/)
    // `agy models` prints one model per line. Current builds emit
    // `<slug>\t<Human label>` (e.g. `gemini-3.8-flash-high\tGemini 3.8 Flash
    // (High)`); older builds printed just `<slug>`. Only the slug is a valid
    // `agy --model` argument, so take the first tab-delimited field as the
    // value — passing the whole line (label included) is what `agy` rejected as
    // "Invalid model" (#492). Fall back to the slug for the label when no label
    // column is present.
    .map((line) => {
      const [rawValue, rawLabel] = line.split('\t');
      const value = (rawValue ?? '').trim();
      const label = (rawLabel ?? '').trim();
      return { value, label: label.length > 0 ? label : value };
    })
    .filter((model) => model.value.length > 0 && !seen.has(model.value) && (seen.add(model.value), true))
    .map((model) => ({
      value: model.value,
      label: model.label,
      description: 'Antigravity CLI model',
    }));

  if (models.length === 0) {
    return ANTIGRAVITY_FALLBACK_MODELS;
  }

  return {
    OPTIONS: models,
    DEFAULT: models[0].value,
  };
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
