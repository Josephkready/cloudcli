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
  OPTIONS: [
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-low',
    'gemini-3.5-flash-medium',
    'gemini-3.5-flash-high',
    'gemini-3.5-flash-low',
    'gemini-3.1-pro-high',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
    'gpt-oss-120b-medium',
  ].map((model) => ({
    value: model,
    label: model,
    description: 'Antigravity CLI model',
  })),
  DEFAULT: 'gemini-3.6-flash-medium',
};

export function parseAntigravityModelsStdout(stdout: string): ProviderModelsDefinition {
  const seen = new Set<string>();
  const models = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !seen.has(line) && (seen.add(line), true))
    .map((model) => ({
      value: model,
      label: model,
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
