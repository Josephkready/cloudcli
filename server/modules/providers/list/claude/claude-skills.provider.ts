import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import { parseFrontMatter } from '@/shared/frontmatter.js';
import type {
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderSkillSource,
} from '@/shared/types.js';
import {
  entryLeadsToDirectory,
  findProviderSkillMarkdownFiles,
  mapWithConcurrency,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readProviderSkillMarkdownDefinition,
} from '@/shared/utils.js';

const getClaudeHomePath = (): string => path.join(os.homedir(), '.claude');

/**
 * Upper bound on concurrent filesystem reads (plugin folder listings, plugin
 * config files, command/skill markdown files) while walking installed
 * plugins, mirroring `SKILLS_READ_CONCURRENCY` in the shared skills provider.
 */
const SKILLS_READ_CONCURRENCY = 12;

const getClaudePluginName = (pluginId: string): string | null => {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId || normalizedPluginId === '@') {
    return null;
  }

  const [pluginName] = normalizedPluginId.split('@');
  return readOptionalString(pluginName) ?? null;
};

const stripMarkdownExtension = (filename: string): string =>
  filename.replace(/\.md$/i, '');

const pathExistsAsDirectory = async (directoryPath: string): Promise<boolean> => {
  try {
    const directoryStats = await stat(directoryPath);
    return directoryStats.isDirectory();
  } catch {
    return false;
  }
};

// Symlinked plugin folders count, for the same reason symlinked skill folders
// do (#345) — see entryLeadsToDirectory.
const listChildDirectories = async (directoryPath: string): Promise<string[]> => {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const childDirectories = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directoryPath, entry.name);
        return (await entryLeadsToDirectory(entryPath, entry)) ? entryPath : null;
      }),
    );

    return childDirectories
      .filter((entryPath): entryPath is string => entryPath !== null)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};

const readClaudePluginName = async (
  installPath: string,
  pluginId: string,
): Promise<string | null> => {
  try {
    const pluginConfig = await readJsonConfig(
      path.join(installPath, '.claude-plugin', 'plugin.json'),
    );

    // Older or partial plugin installs may not have plugin.json yet. Falling
    // back keeps discovery useful without inventing a separate namespace.
    return readOptionalString(pluginConfig.name) ?? getClaudePluginName(pluginId);
  } catch {
    return getClaudePluginName(pluginId);
  }
};

export class ClaudeSkillsProvider extends SkillsProvider {
  constructor() {
    super('claude');
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    return [
      ...(await super.listSkills(options)),
      ...(await this.listPluginSkills(getClaudeHomePath())),
    ];
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const claudeHomePath = getClaudeHomePath();

    return [
      {
        scope: 'user',
        rootDir: path.join(claudeHomePath, 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.claude', 'skills'),
        commandPrefix: '/',
      },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(getClaudeHomePath(), 'skills'),
      commandPrefix: '/',
    };
  }

  private async listPluginSkills(claudeHomePath: string): Promise<ProviderSkill[]> {
    const settings = await readJsonConfig(path.join(claudeHomePath, 'settings.json'));
    const enabledPlugins = readObjectRecord(settings.enabledPlugins);
    if (!enabledPlugins) {
      return [];
    }

    const installedConfig = await readJsonConfig(
      path.join(claudeHomePath, 'plugins', 'installed_plugins.json'),
    );
    const installedPlugins = readObjectRecord(installedConfig.plugins);
    if (!installedPlugins) {
      return [];
    }

    const pluginEntries = Object.entries(enabledPlugins)
      .sort(([left], [right]) => left.localeCompare(right));

    // Discover every (pluginId, pluginFolder) target first. `mapWithConcurrency`
    // preserves input order in its output array, so folder listings and plugin
    // config reads overlap across plugins/installs without disturbing the
    // deterministic dedup pass below.
    const targetsPerEntry = await mapWithConcurrency(
      pluginEntries,
      SKILLS_READ_CONCURRENCY,
      async ([pluginId, enabled]) => {
        if (enabled !== true) {
          return [];
        }

        const installs = installedPlugins[pluginId];
        if (!Array.isArray(installs)) {
          return [];
        }

        const foldersPerInstall = await mapWithConcurrency(
          installs,
          SKILLS_READ_CONCURRENCY,
          async (install) => {
            const installRecord = readObjectRecord(install);
            const installPath = readOptionalString(installRecord?.installPath);
            if (!installPath) {
              return [];
            }

            // Claude's installed path points at one version folder; the usable
            // plugin payloads live in the direct child folders beside it.
            return listChildDirectories(path.dirname(installPath));
          },
        );

        return foldersPerInstall.flat().map((pluginFolder) => ({ pluginId, pluginFolder }));
      },
    );

    const visitedPluginFolders = new Set<string>();
    const targets: Array<{ pluginId: string; pluginFolder: string }> = [];
    for (const group of targetsPerEntry) {
      for (const target of group) {
        const pluginFolderKey = `${target.pluginId}:${path.resolve(target.pluginFolder)}`;
        if (visitedPluginFolders.has(pluginFolderKey)) {
          continue;
        }
        visitedPluginFolders.add(pluginFolderKey);
        targets.push(target);
      }
    }

    const skillsPerTarget = await mapWithConcurrency(
      targets,
      SKILLS_READ_CONCURRENCY,
      async ({ pluginId, pluginFolder }) => {
        const pluginName = await readClaudePluginName(pluginFolder, pluginId);
        if (!pluginName) {
          return [];
        }

        const commandsPath = path.join(pluginFolder, 'commands');
        if (await pathExistsAsDirectory(commandsPath)) {
          return this.listPluginCommandSkills(commandsPath, pluginId, pluginName);
        }

        const skillsPath = path.join(pluginFolder, 'skills');
        if (!(await pathExistsAsDirectory(skillsPath))) {
          return [];
        }

        return this.listPluginSkillMarkdowns(pluginFolder, pluginId, pluginName);
      },
    );

    return skillsPerTarget.flat();
  }

  private async listPluginCommandSkills(
    commandsPath: string,
    pluginId: string,
    pluginName: string,
  ): Promise<ProviderSkill[]> {
    try {
      const entries = await readdir(commandsPath, { withFileTypes: true });
      const commandFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .sort((left, right) => left.name.localeCompare(right.name));

      const skills = await mapWithConcurrency(commandFiles, SKILLS_READ_CONCURRENCY, async (commandFile): Promise<ProviderSkill | null> => {
        const sourcePath = path.join(commandsPath, commandFile.name);
        try {
          const definition = await this.readPluginCommandDefinition(sourcePath);
          return {
            provider: this.provider,
            name: definition.name,
            description: definition.description,
            command: `/${pluginName}:${definition.name}`,
            scope: 'plugin',
            sourcePath,
            pluginName,
            pluginId,
          } satisfies ProviderSkill;
        } catch {
          // Malformed command markdown should not block sibling plugin commands.
          return null;
        }
      });

      return skills.filter((skill): skill is ProviderSkill => skill !== null);
    } catch {
      // Missing or unreadable command folders are treated as empty plugin command sets.
      return [];
    }
  }

  private async readPluginCommandDefinition(
    commandPath: string,
  ): Promise<{ name: string; description: string }> {
    const content = await readFile(commandPath, 'utf8');
    const parsed = parseFrontMatter(content);
    const data = readObjectRecord(parsed.data) ?? {};

    return {
      name: stripMarkdownExtension(path.basename(commandPath)),
      description: readOptionalString(data.description) ?? '',
    };
  }

  private async listPluginSkillMarkdowns(
    installPath: string,
    pluginId: string,
    pluginName: string,
  ): Promise<ProviderSkill[]> {
    const skillFiles = await findProviderSkillMarkdownFiles(path.join(installPath, 'skills'), {
      recursive: true,
    });

    const skills = await mapWithConcurrency(skillFiles, SKILLS_READ_CONCURRENCY, async (skillPath): Promise<ProviderSkill | null> => {
      try {
        const definition = await readProviderSkillMarkdownDefinition(skillPath);
        return {
          provider: this.provider,
          name: definition.name,
          description: definition.description,
          command: `/${pluginName}:${definition.name}`,
          scope: 'plugin',
          sourcePath: skillPath,
          pluginName,
          pluginId,
        } satisfies ProviderSkill;
      } catch {
        // A bad plugin skill file should not block other installed plugin skills.
        return null;
      }
    });

    return skills.filter((skill): skill is ProviderSkill => skill !== null);
  }
}
