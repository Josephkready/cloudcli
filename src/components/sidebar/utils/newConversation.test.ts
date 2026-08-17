import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';

import { buildNewConversationItems, scoreFolderMatch } from './newConversation';

const t = ((key: string, fallback?: string) => fallback ?? key) as never;

function project(
  projectId: string,
  displayName: string,
  options: { isStarred?: boolean; fullPath?: string; isRepository?: boolean } = {},
): Project {
  return {
    projectId,
    displayName,
    fullPath: options.fullPath ?? `/repos/${projectId}`,
    isStarred: options.isStarred,
    isRepository: options.isRepository,
  } as unknown as Project;
}

/** A space the server confirmed is a git repository root. */
function repo(projectId: string, displayName: string, options: { isStarred?: boolean } = {}): Project {
  return project(projectId, displayName, { ...options, isRepository: true });
}

/** A space that exists but isn't a repository root — a subfolder, typically. */
function subfolder(projectId: string, displayName: string, fullPath: string): Project {
  return project(projectId, displayName, { fullPath, isRepository: false });
}

/** A repository root that is a linked worktree rather than a clone (#344). */
function worktree(projectId: string, displayName: string, fullPath: string): Project {
  return {
    ...project(projectId, displayName, { fullPath, isRepository: true }),
    isWorktree: true,
  } as unknown as Project;
}

test('lists each project then a trailing "New project…" escape hatch', () => {
  const { items } = buildNewConversationItems({
    projects: [project('a', 'Alpha'), project('b', 'Bravo')],
    onPickProject: () => {},
    onCreateProject: () => {},
    t,
  });

  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => item.label),
    ['Alpha', 'Bravo', 'New project…'],
  );
  // Each project item carries its folder path as the menu description.
  assert.equal(items[0].description, '/repos/a');
  assert.equal(items[1].description, '/repos/b');
  assert.equal(items[2].key, 'new-project');
  // Divider separates the create action from the project list above it.
  assert.equal(items[2].showDividerBefore, true);
});

test('falls back to projectId for the label when displayName is empty', () => {
  const { items } = buildNewConversationItems({
    projects: [project('lonely-repo', '')],
    onPickProject: () => {},
    onCreateProject: () => {},
    t,
  });

  assert.equal(items[0].label, 'lonely-repo');
});

test('orders projects starred-first, then by name (matches the Projects tab default)', () => {
  const { items } = buildNewConversationItems({
    projects: [project('z', 'Zulu'), project('a', 'Alpha'), project('m', 'Mike', { isStarred: true })],
    onPickProject: () => {},
    onCreateProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['Mike', 'Alpha', 'Zulu', 'New project…'],
  );
});

test('each project item invokes onPickProject with its own project (no closure crosstalk)', () => {
  const picked: string[] = [];
  const projects = [project('a', 'Alpha'), project('b', 'Bravo')];
  const { items } = buildNewConversationItems({
    projects,
    onPickProject: (project) => picked.push(project.projectId),
    onCreateProject: () => {},
    t,
  });

  // Select both, in reverse order, to catch a map closure wiring every item to
  // the same (e.g. last) project.
  items.find((item) => item.key === 'project:b')?.onSelect();
  items.find((item) => item.key === 'project:a')?.onSelect();
  assert.deepEqual(picked, ['b', 'a']);
});

test('the create item invokes onCreateProject, not onPickProject', () => {
  let created = 0;
  let picks = 0;
  const { items } = buildNewConversationItems({
    projects: [project('a', 'Alpha')],
    onPickProject: () => {
      picks += 1;
    },
    onCreateProject: () => {
      created += 1;
    },
    t,
  });

  items.find((item) => item.key === 'new-project')?.onSelect();
  assert.equal(created, 1);
  assert.equal(picks, 0);
});

test('omits the create escape hatch entirely when the caller has no such flow (#331)', () => {
  // The mobile landing page reuses this menu but cannot open the create-project
  // modal — that lives in the sidebar's own state. Rendering the item there
  // would be a control that does nothing, so it is dropped instead.
  const { items } = buildNewConversationItems({
    projects: [project('a', 'Alpha'), project('b', 'Bravo')],
    onPickProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['Alpha', 'Bravo'],
  );
  assert.equal(
    items.some((item) => item.key === 'new-project'),
    false,
  );
});

test('with no projects and no create flow, the menu is empty rather than a lone dead item', () => {
  const { items } = buildNewConversationItems({
    projects: [],
    onPickProject: () => {},
    t,
  });

  assert.deepEqual(items, []);
});

// The mobile landing page (#331) mounts the same picker, and it is the surface
// #332 was reported from — so the repository filter has to hold there too, where
// there is no create-project item to fall back on.
test('filters to repository roots on a surface with no create flow (#331 + #332)', () => {
  const { items, hiddenProjectCount } = buildNewConversationItems({
    projects: [repo('mind', 'mind'), subfolder('sub', 'tools', '/repos/mind/tools')],
    onPickProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['mind'],
  );
  assert.equal(hiddenProjectCount, 1);
});

test('with no projects, the menu is just the create escape hatch (no divider)', () => {
  const { items, hiddenProjectCount } = buildNewConversationItems({
    projects: [],
    onPickProject: () => {},
    onCreateProject: () => {},
    t,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'new-project');
  assert.equal(items[0].showDividerBefore, false);
  assert.equal(hiddenProjectCount, 0);
});

// #332: a space row exists for every session cwd, so agent runs inside a repo
// mint spaces for its subfolders. Those are what the picker's search kept
// matching; only the repository roots belong in it.
test('lists repository roots only, and reports how many spaces that hides', () => {
  const { items, hiddenProjectCount } = buildNewConversationItems({
    projects: [
      repo('mind', 'mind'),
      subfolder('mind-tools', 'harness-token-audit', '/repos/mind/tools/harness-token-audit'),
      subfolder('scratch', 'scratchpad', '/tmp/claude-1000/scratchpad'),
      repo('cloudcli', 'cloudcli'),
    ],
    onPickProject: () => {},
    onCreateProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['cloudcli', 'mind', 'New project…'],
  );
  assert.equal(hiddenProjectCount, 2);
});

test('includeNonRepositories reveals the plain folders, and still counts them as the hidden set', () => {
  const projects = [
    repo('mind', 'mind'),
    subfolder('mind-tools', 'harness-token-audit', '/repos/mind/tools/harness-token-audit'),
  ];

  const { items, hiddenProjectCount } = buildNewConversationItems({
    projects,
    onPickProject: () => {},
    onCreateProject: () => {},
    includeNonRepositories: true,
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['harness-token-audit', 'mind', 'New project…'],
  );
  // The count labels the toggle, so it must not collapse to 0 once it is on —
  // that would make the "show repositories only" way back disappear.
  assert.equal(hiddenProjectCount, 2 - 1);
});

// #344: #332's repository filter left the picker still full of folders nobody
// starts a conversation in, because a linked worktree *is* a repository root.
// On the reporter's machine 21 of the 46 listed spaces were agent worktrees.
test('hides linked worktrees, keeping only the clones behind the default listing', () => {
  const { items, hiddenProjectCount } = buildNewConversationItems({
    projects: [
      repo('mind', 'mind'),
      worktree('mind-wt', 'mind.enrich-career-coach-profiles', '/repos/mind.enrich-a72ffaf5'),
      worktree('agent-wt', 'round2-apob-cvd', '/home/j/.cache/omni/run-1/wt/round2-apob-cvd'),
      repo('cloudcli', 'cloudcli'),
    ],
    onPickProject: () => {},
    onCreateProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['cloudcli', 'mind', 'New project…'],
  );
  // Both worktrees join the hidden set the "show all folders" toggle reveals.
  assert.equal(hiddenProjectCount, 2);
});

test('includeNonRepositories reveals worktrees alongside plain folders', () => {
  const { items } = buildNewConversationItems({
    projects: [
      repo('mind', 'mind'),
      worktree('mind-wt', 'mind.feature-branch', '/repos/mind.feature-branch'),
      subfolder('sub', 'tools', '/repos/mind/tools'),
    ],
    onPickProject: () => {},
    includeNonRepositories: true,
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['mind', 'mind.feature-branch', 'tools'],
  );
});

// A server predating the worktree flag reports isRepository but not isWorktree.
// Treating "unknown" as "worktree" would empty the picker of every repository.
test('a repository with no worktree flag is listed (older server payload)', () => {
  const { items, hiddenProjectCount } = buildNewConversationItems({
    projects: [repo('mind', 'mind'), repo('cloudcli', 'cloudcli')],
    onPickProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['cloudcli', 'mind'],
  );
  assert.equal(hiddenProjectCount, 0);
});

test('a starred worktree is still hidden (starring does not make it a clone)', () => {
  const { items } = buildNewConversationItems({
    projects: [
      repo('mind', 'mind'),
      { ...worktree('wt', 'Scratch WT', '/repos/mind.wt'), isStarred: true } as unknown as Project,
    ],
    onPickProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['mind'],
  );
});

test('a starred subfolder is still filtered out (starring is not a repository)', () => {
  const { items } = buildNewConversationItems({
    projects: [
      repo('mind', 'mind'),
      { ...subfolder('sub', 'Sub', '/repos/mind/sub'), isStarred: true },
    ],
    onPickProject: () => {},
    onCreateProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['mind', 'New project…'],
  );
});

test('nothing is hidden when every space is a repository root', () => {
  const { items, hiddenProjectCount } = buildNewConversationItems({
    projects: [repo('a', 'Alpha'), repo('b', 'Bravo')],
    onPickProject: () => {},
    onCreateProject: () => {},
    t,
  });

  assert.equal(items.length, 3);
  assert.equal(hiddenProjectCount, 0);
});

// Filtering on a bit the payload never carried would empty the picker outright,
// so a server that predates the flag degrades to the old list-everything menu.
test('lists every space when no project carries the repository flag', () => {
  const { items, hiddenProjectCount } = buildNewConversationItems({
    projects: [project('a', 'Alpha'), project('b', 'Bravo')],
    onPickProject: () => {},
    onCreateProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['Alpha', 'Bravo', 'New project…'],
  );
  assert.equal(hiddenProjectCount, 0);
});

/*
 * Search ranking (#344, second half).
 *
 * cmdk's default filter is a subsequence match: it accepts an item whenever the
 * query's characters appear in order anywhere in the item's value. Against full
 * filesystem paths that matches almost everything — typing "mind" surfaced
 * `datapoint`, `audio-processing-library` and four `.cache/omni-harness/…/repo`
 * clones, because o**m**n**i**-har**n**ess…**d** spells it. The picker searches
 * folders, so a plain substring is the right rule.
 */

test('scoreFolderMatch: an empty query keeps everything', () => {
  assert.ok(scoreFolderMatch('mind', '/repos/mind', '') > 0);
});

test('scoreFolderMatch: a subsequence that is not a substring does not match', () => {
  // The exact false positives seen in the picker.
  assert.equal(scoreFolderMatch('repo', '/home/j/.cache/omni-harness/refinery/run-1/repo', 'mind'), 0);
  assert.equal(scoreFolderMatch('datapoint', '/home/j/repos/datapoint', 'mind'), 0);
  assert.equal(scoreFolderMatch('audio-processing-library', '/home/j/repos/audio-processing-library', 'mind'), 0);
});

test('scoreFolderMatch: a name substring matches', () => {
  assert.ok(scoreFolderMatch('mind', '/repos/mind', 'mind') > 0);
  assert.ok(scoreFolderMatch('wall-display', '/repos/wall-display', 'display') > 0);
});

test('scoreFolderMatch: matching the name outranks matching only the path', () => {
  const byName = scoreFolderMatch('mind', '/home/j/repos/mind', 'mind');
  const byPath = scoreFolderMatch('notes', '/home/j/repos/mind/notes', 'mind');
  assert.ok(byName > byPath, `expected name match (${byName}) to outrank path match (${byPath})`);
  assert.ok(byPath > 0, 'a path substring should still be reachable');
});

test('scoreFolderMatch: an exact name outranks a longer name containing it', () => {
  const exact = scoreFolderMatch('mind', '/repos/mind', 'mind');
  const prefixed = scoreFolderMatch('mind-search', '/repos/mind-search', 'mind');
  assert.ok(exact > prefixed, `expected exact (${exact}) to beat prefix (${prefixed})`);
});

test('scoreFolderMatch: matching is case-insensitive and ignores surrounding spaces', () => {
  assert.ok(scoreFolderMatch('CloudCLI', '/repos/cloudcli', '  cloud  ') > 0);
});

test('scoreFolderMatch: a query matching nothing leaves the list empty', () => {
  // Including the "New project…" row: #338 wants the "No folders found" message
  // in that case, not a single surviving action.
  assert.equal(scoreFolderMatch('New project…', '', 'zzz-nothing-matches'), 0);
  assert.equal(scoreFolderMatch('mind', '/repos/mind', 'zzz-nothing-matches'), 0);
});

/*
 * Repositories buried in a hidden directory (#344, third pass).
 *
 * Hiding worktrees left seven `~/.cache/omni-harness/refinery/run-<id>/repo`
 * entries in the picker. Those are ordinary clones, so no git-shaped rule can
 * exclude them — but a checkout under a dot-directory is a tool's private
 * working copy, not a project anyone opens a conversation in. `~/repos/...`
 * is unaffected; the "show all folders" toggle still reaches them.
 */

test('hides repositories living under a hidden dot-directory', () => {
  const { items, hiddenProjectCount } = buildNewConversationItems({
    projects: [
      repo('mind', 'mind'),
      { ...repo('cache-repo', 'repo'), fullPath: '/home/j/.cache/omni-harness/refinery/run-1/repo' } as Project,
      { ...repo('gem', 'skills'), fullPath: '/home/j/.gemini/antigravity-cli/skills' } as Project,
    ],
    onPickProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['mind'],
  );
  assert.equal(hiddenProjectCount, 2);
});

test('a dot in a file/folder name is not a hidden directory', () => {
  // `mind.integration` is a normal sibling repo, not a dotfile path.
  const { items } = buildNewConversationItems({
    projects: [
      { ...repo('dotted', 'mind.integration'), fullPath: '/home/j/repos/mind.integration' } as Project,
      { ...repo('trailing', 'v1.2.3-release'), fullPath: '/home/j/repos/v1.2.3-release' } as Project,
    ],
    onPickProject: () => {},
    t,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ['mind.integration', 'v1.2.3-release'],
  );
});

test('the home directory itself is not treated as hidden', () => {
  const { items } = buildNewConversationItems({
    projects: [{ ...repo('home', 'jkready'), fullPath: '/home/jkready' } as Project],
    onPickProject: () => {},
    t,
  });

  assert.deepEqual(items.map((item) => item.label), ['jkready']);
});

test('revealing all folders still reaches a hidden-directory repository', () => {
  const { items } = buildNewConversationItems({
    projects: [
      repo('mind', 'mind'),
      { ...repo('cache-repo', 'repo'), fullPath: '/home/j/.cache/omni/run-1/repo' } as Project,
    ],
    onPickProject: () => {},
    includeNonRepositories: true,
    t,
  });

  assert.equal(items.length, 2);
});
