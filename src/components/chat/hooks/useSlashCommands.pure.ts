/**
 * Pure slash-command helpers for `useSlashCommands`.
 *
 * Command shapes and the match/dedup rules that decide what the slash menu
 * shows. No React, no fetch, no storage — `useSlashCommands` owns those.
 */

export interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: 'built-in' | 'custom' | 'skill' | string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ProviderSkill = {
  name: string;
  description?: string;
  command: string;
  scope: string;
  sourcePath?: string;
  pluginName?: string;
  pluginId?: string;
};

export const isSkillCommand = (command: SlashCommand) =>
  command.type === 'skill' || command.metadata?.type === 'skill';

export const dedupeProviderSkills = (skills: ProviderSkill[]): ProviderSkill[] => {
  const seenCommands = new Set<string>();

  return skills.filter((skill) => {
    // Multiple physical Claude plugin folders can expose the same invocation.
    // The slash menu should show each executable command only once.
    const key = skill.command;
    if (seenCommands.has(key)) {
      return false;
    }

    seenCommands.add(key);
    return true;
  });
};

export const mapSkillToSlashCommand = (skill: ProviderSkill): SlashCommand => ({
  name: skill.command,
  description: skill.description,
  namespace: 'skill',
  path: skill.sourcePath,
  type: 'skill',
  metadata: {
    type: skill.scope,
    scope: skill.scope,
    sourcePath: skill.sourcePath,
    pluginName: skill.pluginName,
    pluginId: skill.pluginId,
    skillName: skill.name,
  },
});

/**
 * Removes a single leading command sigil, if there is one.
 *
 * `/` is Claude's and `$` is Codex's. Anchored and non-greedy by construction so
 * that only the first character can ever be removed — a name is otherwise
 * untouched.
 */
const stripCommandSigil = (value: string): string => value.replace(/^[/$]/, '');

/**
 * Rank a typed query against the loaded command list, most-specific first:
 * command-name prefix, then command-name substring, then description
 * substring. Once the query names a namespace (`plugin:`) only prefix matches
 * stay visible so it behaves like path completion.
 *
 * Matching ignores the leading sigil on both sides, so a skill is findable by
 * name whichever provider owns it — see {@link stripCommandSigil}.
 */
export const filterSlashCommands = (
  commands: SlashCommand[],
  query: string,
): SlashCommand[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }

  // The leading sigil is dropped from both sides before comparing (#356).
  //
  // Providers name their skills differently — Claude uses `/okr`, Codex uses
  // `$okr` — but that is an invocation detail, not something a user should have
  // to know in order to *search*. Normalising the query to `/` and comparing it
  // whole meant a Codex user typing `/okr` matched nothing, and a bare `/`
  // matched no Codex command at all, so the menu simply came up empty.
  //
  // Only the sigil is stripped, and only from the front. Everything after it
  // still has to match as a prefix, so `okr` does not reach `dante-live`.
  const needle = stripCommandSigil(normalizedQuery);
  const namePrefixMatches = commands.filter((command) =>
    stripCommandSigil(command.name.toLowerCase()).startsWith(needle),
  );

  // Namespaced commands should behave like path completion. Once a provider
  // namespace is typed, only exact command-prefix matches should stay visible.
  if (normalizedQuery.includes(':') || namePrefixMatches.length > 0) {
    return namePrefixMatches;
  }

  const nameSubstringMatches = commands.filter((command) =>
    stripCommandSigil(command.name.toLowerCase()).includes(needle),
  );
  if (nameSubstringMatches.length > 0) {
    return nameSubstringMatches;
  }

  // Descriptions are searched with the sigil stripped too, or the function
  // contradicts itself: `token` would find `/cost` by its description while
  // `/token` found nothing, which is the same surprise #356 is about.
  return commands.filter((command) =>
    Boolean(command.description?.toLowerCase().includes(needle)),
  );
};
