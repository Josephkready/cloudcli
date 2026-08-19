import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterSlashCommands } from './useSlashCommands.pure';
import type { SlashCommand } from './useSlashCommands.pure';

/**
 * A skill must be findable by name, whichever sigil the provider gives it
 * (#356).
 *
 * Codex names its skills `$okr`; Claude names them `/okr`. The reporter typed
 * `/okr` under Codex and got nothing back — not because the skill was missing
 * from the list by then, but because the filter compared the typed `/` against
 * the stored `$` and no candidate could ever match.
 *
 * The `/` case is the sharp end of it. `filterSlashCommands` normalises any
 * query to start with `/`, so under Codex a bare `/` matched **no command at
 * all** and the menu came up empty — which reads exactly as "skills with codex
 * aren't appearing", and is the same report whether or not the skills loaded.
 *
 * The sigil is a display and invocation detail of the provider. It should not be
 * something a user has to know in order to search.
 */

const command = (name: string, description?: string): SlashCommand => ({ name, description });
const names = (commands: SlashCommand[]): string[] => commands.map((c) => c.name);

const CODEX: SlashCommand[] = [
  command('$okr', 'Quarterly OKRs'),
  command('$dante-live', 'Remote VM operations'),
  command('$okr-scheduling', 'Schedule OKR reviews'),
];

const MIXED: SlashCommand[] = [...CODEX, command('/review-pr', 'Review a GitHub pull request')];

describe('filterSlashCommands is sigil-agnostic', () => {
  it('finds a $-prefixed skill when the user types / (#356)', () => {
    assert.deepEqual(names(filterSlashCommands(CODEX, '/okr')), ['$okr', '$okr-scheduling']);
  });

  it('finds a /-prefixed command when the user types $', () => {
    assert.deepEqual(names(filterSlashCommands(MIXED, '$review')), ['/review-pr']);
  });

  it('still finds a skill typed with its own sigil', () => {
    assert.deepEqual(names(filterSlashCommands(CODEX, '$okr')), ['$okr', '$okr-scheduling']);
  });

  it('still finds a skill typed bare', () => {
    assert.deepEqual(names(filterSlashCommands(CODEX, 'okr')), ['$okr', '$okr-scheduling']);
  });

  it('a bare sigil lists every command rather than only its own kind', () => {
    // The empty-menu case. Neither sigil should act as a filter on its own.
    assert.deepEqual(names(filterSlashCommands(MIXED, '/')), names(MIXED));
    assert.deepEqual(names(filterSlashCommands(MIXED, '$')), names(MIXED));
  });

  it('searches descriptions with the sigil stripped as well', () => {
    // Otherwise the function contradicts itself: a bare `token` reaches the
    // description while `/token` does not, which is the #356 surprise again.
    const withDescription = [command('$cost', 'Show token cost for this session')];
    assert.deepEqual(names(filterSlashCommands(withDescription, '/token')), ['$cost']);
    assert.deepEqual(names(filterSlashCommands(withDescription, 'token')), ['$cost']);
  });

  it('does not match across the sigil boundary into the middle of a name', () => {
    // Guard against the lazy fix of stripping sigils everywhere and falling back
    // to substring matching: `okr` must not match `dante-live`.
    assert.deepEqual(names(filterSlashCommands(CODEX, '/dante')), ['$dante-live']);
  });
});
