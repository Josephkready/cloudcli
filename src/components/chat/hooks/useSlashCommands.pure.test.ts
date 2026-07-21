import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dedupeProviderSkills,
  filterSlashCommands,
  isSkillCommand,
  mapSkillToSlashCommand,
} from './useSlashCommands.pure';
import type { ProviderSkill, SlashCommand } from './useSlashCommands.pure';

const command = (name: string, description?: string): SlashCommand => ({ name, description });

const names = (commands: SlashCommand[]): string[] => commands.map((c) => c.name);

const COMMANDS: SlashCommand[] = [
  command('/help', 'Show available commands'),
  command('/cost', 'Show token cost for this session'),
  command('/compact', 'Compact the conversation'),
  command('/review-pr', 'Review a GitHub pull request'),
  command('/frontend:build', 'Build the front-end bundle'),
  command('/frontend:test', 'Run the front-end tests'),
  command('/deploy', 'Ship the compacted build to production'),
];

describe('filterSlashCommands', () => {
  it('shows everything for an empty or whitespace query', () => {
    assert.equal(filterSlashCommands(COMMANDS, ''), COMMANDS);
    assert.equal(filterSlashCommands(COMMANDS, '   '), COMMANDS);
  });

  it('prefers command-name prefix matches', () => {
    assert.deepEqual(names(filterSlashCommands(COMMANDS, 'co')), ['/cost', '/compact']);
  });

  it('treats a leading slash in the query as optional', () => {
    assert.deepEqual(
      names(filterSlashCommands(COMMANDS, '/co')),
      names(filterSlashCommands(COMMANDS, 'co')),
    );
  });

  it('is case-insensitive', () => {
    assert.deepEqual(names(filterSlashCommands(COMMANDS, 'HeLp')), ['/help']);
  });

  it('ignores surrounding whitespace', () => {
    assert.deepEqual(names(filterSlashCommands(COMMANDS, '  help  ')), ['/help']);
  });

  it('anchors the prefix match at the start of the command name', () => {
    // Commands scanned out of subdirectories are named by path, so
    // "/git/commit" *contains* "/commit" without starting with it. It must not
    // out-rank the command actually named "/commit-all".
    const nested = [command('/git/commit', 'Create a git commit'), command('/commit-all')];
    assert.deepEqual(names(filterSlashCommands(nested, 'commit')), ['/commit-all']);
  });

  it('still finds a nested command by its own path prefix', () => {
    const nested = [command('/git/commit'), command('/help')];
    assert.deepEqual(names(filterSlashCommands(nested, 'git')), ['/git/commit']);
  });

  it('falls back to a name substring when no command starts with the query', () => {
    // Nothing starts with "/pr", but `/review-pr` contains it.
    assert.deepEqual(names(filterSlashCommands(COMMANDS, 'pr')), ['/review-pr']);
  });

  it('falls back to the description only when the name matches nothing', () => {
    assert.deepEqual(names(filterSlashCommands(COMMANDS, 'token')), ['/cost']);
  });

  it('prefers a name substring over a description match', () => {
    // "compact" appears in /deploy's description too — the name wins outright.
    assert.deepEqual(names(filterSlashCommands(COMMANDS, 'compact')), ['/compact']);
  });

  it('narrows a namespace query to prefix matches only', () => {
    assert.deepEqual(names(filterSlashCommands(COMMANDS, 'frontend:')), [
      '/frontend:build',
      '/frontend:test',
    ]);
    assert.deepEqual(names(filterSlashCommands(COMMANDS, 'frontend:t')), ['/frontend:test']);
  });

  it('does not fall back to substring or description once a namespace is typed', () => {
    // A namespaced query behaves like path completion: no match means no menu,
    // even though "build" appears in a description.
    assert.deepEqual(names(filterSlashCommands(COMMANDS, 'backend:build')), []);
    assert.deepEqual(names(filterSlashCommands(COMMANDS, ':')), []);
  });

  it('returns nothing when neither name nor description matches', () => {
    assert.deepEqual(filterSlashCommands(COMMANDS, 'zzzz'), []);
  });

  it('tolerates commands with no description', () => {
    const sparse = [command('/help'), command('/cost')];
    assert.deepEqual(filterSlashCommands(sparse, 'token'), []);
  });

  it('preserves the incoming order, which is usage-ranked', () => {
    const ranked = [command('/compact'), command('/cost')];
    assert.deepEqual(names(filterSlashCommands(ranked, 'co')), ['/compact', '/cost']);
  });

  it('does not mutate the command list', () => {
    const input = [...COMMANDS];
    filterSlashCommands(input, 'co');
    assert.deepEqual(names(input), names(COMMANDS));
  });
});

describe('isSkillCommand', () => {
  it('recognises both the top-level and metadata markers', () => {
    assert.equal(isSkillCommand({ name: '/x', type: 'skill' }), true);
    assert.equal(isSkillCommand({ name: '/x', metadata: { type: 'skill' } }), true);
  });

  it('rejects built-in and custom commands', () => {
    assert.equal(isSkillCommand({ name: '/x', type: 'built-in' }), false);
    assert.equal(isSkillCommand({ name: '/x', type: 'custom', metadata: { type: 'project' } }), false);
    assert.equal(isSkillCommand({ name: '/x' }), false);
  });
});

describe('dedupeProviderSkills', () => {
  const skill = (command: string, name = command): ProviderSkill => ({
    name,
    command,
    scope: 'project',
  });

  it('keeps the first skill per invocation', () => {
    const deduped = dedupeProviderSkills([
      skill('/deploy', 'first'),
      skill('/deploy', 'second'),
      skill('/build'),
    ]);
    assert.deepEqual(deduped.map((s) => s.name), ['first', '/build']);
  });

  it('passes an already-unique list straight through', () => {
    const skills = [skill('/a'), skill('/b')];
    assert.deepEqual(dedupeProviderSkills(skills), skills);
  });

  it('handles an empty list', () => {
    assert.deepEqual(dedupeProviderSkills([]), []);
  });
});

describe('mapSkillToSlashCommand', () => {
  it('uses the invocation as the command name and keeps the skill name in metadata', () => {
    const mapped = mapSkillToSlashCommand({
      name: 'deploy-app',
      command: '/plugin:deploy-app',
      description: 'Ship it',
      scope: 'user',
      sourcePath: '/home/dev/.claude/skills/deploy-app',
      pluginName: 'plugin',
      pluginId: 'plugin@1',
    });

    assert.equal(mapped.name, '/plugin:deploy-app');
    assert.equal(mapped.description, 'Ship it');
    assert.equal(mapped.namespace, 'skill');
    assert.equal(mapped.type, 'skill');
    assert.equal(mapped.path, '/home/dev/.claude/skills/deploy-app');
    assert.deepEqual(mapped.metadata, {
      type: 'user',
      scope: 'user',
      sourcePath: '/home/dev/.claude/skills/deploy-app',
      pluginName: 'plugin',
      pluginId: 'plugin@1',
      skillName: 'deploy-app',
    });
  });

  it('produces something the skill check recognises', () => {
    assert.equal(
      isSkillCommand(mapSkillToSlashCommand({ name: 'x', command: '/x', scope: 'project' })),
      true,
    );
  });

  it('is filterable by its namespaced name', () => {
    const mapped = mapSkillToSlashCommand({ name: 'x', command: '/plugin:x', scope: 'project' });
    assert.deepEqual(names(filterSlashCommands([mapped], 'plugin:')), ['/plugin:x']);
  });
});
