import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';

import { buildNewConversationItems } from './newConversation';

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
