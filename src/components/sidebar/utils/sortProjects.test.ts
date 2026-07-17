import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';

import { sortProjects } from './utils';

function project(
  projectId: string,
  total: number,
  options: { isStarred?: boolean } = {},
): Project {
  return {
    projectId,
    displayName: projectId,
    fullPath: `/repos/${projectId}`,
    isStarred: Boolean(options.isStarred),
    sessionMeta: { total },
    sessions: [],
  };
}

test("'count' mode orders by session total, most first", () => {
  const projects = [
    project('small', 3),
    project('big', 104),
    project('medium', 80),
  ];

  const sorted = sortProjects(projects, 'count');

  assert.deepEqual(sorted.map((p) => p.projectId), ['big', 'medium', 'small']);
});

test("'count' mode keeps starred projects pinned above unstarred ones", () => {
  // The starred project has the *smallest* count yet must still float to the top.
  const projects = [
    project('busy', 104),
    project('starred', 2, { isStarred: true }),
    project('quiet', 9),
  ];

  const sorted = sortProjects(projects, 'count');

  assert.equal(sorted[0].projectId, 'starred');
  // Within the unstarred band, count order still holds.
  assert.deepEqual(sorted.slice(1).map((p) => p.projectId), ['busy', 'quiet']);
});

test("'count' mode breaks ties by name for stable ordering", () => {
  const projects = [
    project('charlie', 10),
    project('alpha', 10),
    project('bravo', 10),
  ];

  const sorted = sortProjects(projects, 'count');

  assert.deepEqual(sorted.map((p) => p.projectId), ['alpha', 'bravo', 'charlie']);
});

test("missing sessionMeta.total is treated as zero", () => {
  const withCount = project('has-sessions', 5);
  const withoutMeta: Project = {
    projectId: 'no-meta',
    displayName: 'no-meta',
    fullPath: '/repos/no-meta',
    sessions: [],
  };

  const sorted = sortProjects([withoutMeta, withCount], 'count');

  assert.deepEqual(sorted.map((p) => p.projectId), ['has-sessions', 'no-meta']);
});

test("falls back to loaded session count when sessionMeta is absent", () => {
  // Mirrors the count-badge fallback in SidebarProjectItem: with no
  // `sessionMeta`, the number of loaded `sessions` stands in for the total.
  const metaless = (projectId: string, loaded: number): Project => ({
    projectId,
    displayName: projectId,
    fullPath: `/repos/${projectId}`,
    sessions: Array.from({ length: loaded }, (_, i) => ({ id: `${projectId}-${i}`, summary: '' })),
  });

  const sorted = sortProjects([metaless('few', 2), metaless('many', 9)], 'count');

  assert.deepEqual(sorted.map((p) => p.projectId), ['many', 'few']);
});
