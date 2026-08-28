import { renderHook, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../types/app';

import { useSlashCommands } from './useSlashCommands';

/*
 * What makes this hook refetch, and what it asks for when it does.
 *
 * The command list is derived from two endpoints — `/api/commands/list` and
 * `/api/providers/:provider/skills` — and its effect used to depend on the
 * `selectedProject` *object*. That object is replaced constantly: every
 * `/api/projects` refresh, every session-list merge, every `last_viewed_at`
 * bump mints a new one for the same project. So opening a conversation refetched
 * a list that had not changed, twice, on the same single-threaded server that
 * was busy reading the transcript.
 *
 * The dependency is now the project's identity rather than its identity-in-JS.
 * That distinction is invisible to a rendering test and to the type system, so
 * it is pinned here: a fresh object for the same project must not refetch, and a
 * genuinely different project must.
 */

const mockFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));

const project = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'project-1',
  name: 'bench',
  path: '/workspace/bench',
  fullPath: '/workspace/bench',
  displayName: 'bench',
  sessions: [],
  ...overrides,
} as Project);

const commandsResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ builtIn: [{ name: 'init' }], custom: [{ name: 'deploy' }] }),
});

const skillsResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    data: {
      skills: [{ name: 'review-pr', command: 'review-pr', description: 'Review', scope: 'user' }],
    },
  }),
});

function renderSlashCommands(initialProject: Project | null) {
  return renderHook(
    ({ selectedProject }: { selectedProject: Project | null }) =>
      useSlashCommands({
        selectedProject,
        provider: 'claude',
        input: '',
        setInput: () => {},
        textareaRef: createRef<HTMLTextAreaElement>(),
        onExecuteCommand: () => {},
      }),
    { initialProps: { selectedProject: initialProject } },
  );
}

const requestedUrls = () => mockFetch.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(String(url).includes('/skills') ? skillsResponse() : commandsResponse()),
  );
});

describe('useSlashCommands — when the command list is refetched', () => {
  it('loads commands and skills together for the selected project', async () => {
    const { result } = renderSlashCommands(project());

    await waitFor(() => expect(result.current.slashCommands.length).toBeGreaterThan(0));

    const urls = requestedUrls();
    expect(urls.some((url) => url === '/api/commands/list')).toBe(true);
    expect(urls.some((url) => url.startsWith('/api/providers/claude/skills'))).toBe(true);
    // Skills are merged into the same list, not fetched and dropped.
    expect(result.current.slashCommands.map((command) => command.name)).toEqual(
      expect.arrayContaining(['init', 'deploy', 'review-pr']),
    );
  });

  it('does not refetch when the same project arrives as a new object', async () => {
    const { result, rerender } = renderSlashCommands(project());
    await waitFor(() => expect(result.current.slashCommands.length).toBeGreaterThan(0));
    const callsAfterFirstLoad = mockFetch.mock.calls.length;

    // A new object, same project — exactly what a projects refresh produces.
    rerender({ selectedProject: project() });
    rerender({ selectedProject: project() });

    await waitFor(() => expect(result.current.slashCommands.length).toBeGreaterThan(0));
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirstLoad);
  });

  it('does refetch when the project actually changes', async () => {
    const { result, rerender } = renderSlashCommands(project());
    await waitFor(() => expect(result.current.slashCommands.length).toBeGreaterThan(0));
    const callsAfterFirstLoad = mockFetch.mock.calls.length;

    rerender({
      selectedProject: project({
        projectId: 'project-2',
        path: '/workspace/other',
        fullPath: '/workspace/other',
      }),
    });

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(callsAfterFirstLoad));
    expect(requestedUrls().some((url) => url.includes(encodeURIComponent('/workspace/other')))).toBe(true);
  });

  it('clears the list when no project is selected, without fetching', async () => {
    const { result } = renderSlashCommands(null);

    await waitFor(() => expect(result.current.slashCommands).toEqual([]));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still requests skills when the commands endpoint fails, and reports an empty list', async () => {
    // The two requests are issued together now rather than one after the other,
    // so a failing commands leg no longer cancels the skills leg before it is
    // sent. The list is still emptied — a half-populated menu would be worse
    // than an empty one — but the behaviour is deliberate and worth pinning.
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('/skills') ? skillsResponse() : { ok: false, status: 500, json: async () => ({}) },
      ),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderSlashCommands(project());

    await waitFor(() => expect(errors).toHaveBeenCalled());
    expect(requestedUrls().some((url) => url.startsWith('/api/providers/claude/skills'))).toBe(true);
    expect(result.current.slashCommands).toEqual([]);

    errors.mockRestore();
  });
});
