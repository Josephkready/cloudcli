import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpProject, McpProvider, ProviderMcpServer } from '../types';

import { useMcpServers } from './useMcpServers';

const { authenticatedFetch } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function makeServer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'server-1',
    scope: 'user',
    transport: 'stdio',
    command: 'run',
    ...overrides,
  };
}

const EMPTY_PROJECTS: McpProject[] = [];

const projects: McpProject[] = [
  { projectId: 'p1', displayName: 'Project One', fullPath: '/proj/one' },
];

describe('useMcpServers', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('loads user + project + local scope servers for claude and sorts them', async () => {
    authenticatedFetch.mockImplementation(async (url: string) => {
      if (url.includes('scope=user')) {
        return jsonResponse({ success: true, data: { servers: [makeServer({ name: 'zeta' })] } });
      }
      if (url.includes('scope=project')) {
        return jsonResponse({ success: true, data: { servers: [makeServer({ name: 'alpha', scope: 'project' })] } });
      }
      if (url.includes('scope=local')) {
        return jsonResponse({ success: true, data: { servers: [] } });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'claude', currentProjects: projects }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.isLoadingProjectScopes).toBe(false));

    expect(result.current.loadError).toBeNull();
    expect(result.current.servers.map((s) => s.name)).toEqual(['zeta', 'alpha']);
    expect(result.current.servers[1].scope).toBe('project');
    // user scope sorts before project scope regardless of name
    expect(result.current.servers[0].scope).toBe('user');
  });

  it('surfaces the first error while still keeping any successfully-loaded servers', async () => {
    authenticatedFetch.mockImplementation(async (url: string) => {
      if (url.includes('scope=user')) {
        return jsonResponse({ success: false, error: { message: 'user scope boom' } }, false);
      }
      return jsonResponse({ success: true, data: { servers: [] } });
    });

    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'claude', currentProjects: EMPTY_PROJECTS }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.loadError).toBe('user scope boom'));
    expect(result.current.servers).toEqual([]);
  });

  it('caches results across refreshServers calls until forced', async () => {
    authenticatedFetch.mockImplementation(async () => jsonResponse({ success: true, data: { servers: [makeServer()] } }));

    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'codex', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const callsAfterFirstLoad = authenticatedFetch.mock.calls.length;
    expect(callsAfterFirstLoad).toBeGreaterThan(0);

    await act(async () => {
      await result.current.refreshServers();
    });
    // cache hit: no new network calls
    expect(authenticatedFetch.mock.calls.length).toBe(callsAfterFirstLoad);

    await act(async () => {
      await result.current.refreshServers({ force: true });
    });
    expect(authenticatedFetch.mock.calls.length).toBeGreaterThan(callsAfterFirstLoad);
  });

  it('opens and closes the provider form, tracking the editing server', () => {
    authenticatedFetch.mockResolvedValue(jsonResponse({ success: true, data: { servers: [] } }));
    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'claude', currentProjects: EMPTY_PROJECTS }));

    const server = makeServer() as unknown as ProviderMcpServer;
    act(() => result.current.openForm(server));
    expect(result.current.isFormOpen).toBe(true);
    expect(result.current.editingServer).toEqual(server);

    act(() => result.current.closeForm());
    expect(result.current.isFormOpen).toBe(false);
    expect(result.current.editingServer).toBeNull();

    act(() => result.current.openGlobalForm());
    expect(result.current.isGlobalFormOpen).toBe(true);
    act(() => result.current.closeGlobalForm());
    expect(result.current.isGlobalFormOpen).toBe(false);
  });

  it('submits a new provider-scoped server: saves, refreshes, and reports success', async () => {
    let savedPayload: unknown = null;
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/mcp/servers?scope=user')) {
        return jsonResponse({ success: true, data: { servers: [] } });
      }
      if (url === '/api/providers/claude/mcp/servers' && init?.method === 'POST') {
        savedPayload = JSON.parse(String(init.body));
        return jsonResponse({ success: true, data: { server: makeServer() } });
      }
      if (url.includes('scope=project') || url.includes('scope=local')) {
        return jsonResponse({ success: true, data: { servers: [] } });
      }
      throw new Error(`unexpected ${url}`);
    });

    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'claude', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.submitForm(
        {
          name: 'new-server',
          scope: 'user',
          workspacePath: '',
          transport: 'stdio',
          command: 'run-me',
          args: [],
          env: {},
          cwd: '',
          url: '',
          headers: {},
          envVars: [],
          bearerTokenEnvVar: '',
          envHttpHeaders: {},
          importMode: 'form',
          jsonInput: '',
        },
        null,
      );
    });

    expect(savedPayload).toMatchObject({ name: 'new-server', scope: 'user' });
    expect(result.current.isFormOpen).toBe(false);
    expect(result.current.saveStatus).toBe('success');
  });

  it('rejects a project-scoped submission with no workspace selected', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse({ success: true, data: { servers: [] } }));
    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'claude', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      act(async () => {
        await result.current.submitForm(
          {
            name: 'x',
            scope: 'project',
            workspacePath: '',
            transport: 'stdio',
            command: 'cmd',
            args: [],
            env: {},
            cwd: '',
            url: '',
            headers: {},
            envVars: [],
            bearerTokenEnvVar: '',
            envHttpHeaders: {},
            importMode: 'form',
            jsonInput: '',
          },
          null,
        );
      }),
    ).rejects.toThrow('Select a project for project-scoped MCP servers');
  });

  it('deletes a server after confirmation and refreshes the list', async () => {
    let deleted = false;
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return jsonResponse({ success: true, data: { removed: true } });
      }
      return jsonResponse({ success: true, data: { servers: deleted ? [] : [makeServer()] } });
    });

    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'codex', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteServer(makeServer() as unknown as ProviderMcpServer);
    });

    expect(deleted).toBe(true);
    expect(result.current.saveStatus).toBe('success');
    expect(result.current.deleteError).toBeNull();
  });

  it('does not delete when the user cancels the confirm dialog', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    authenticatedFetch.mockResolvedValue(jsonResponse({ success: true, data: { servers: [] } }));
    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'codex', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const callsBefore = authenticatedFetch.mock.calls.length;
    await act(async () => {
      await result.current.deleteServer(makeServer() as unknown as ProviderMcpServer);
    });
    expect(authenticatedFetch.mock.calls.length).toBe(callsBefore);
  });

  it('sets deleteError and error saveStatus when the delete call fails', async () => {
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ success: false, error: { message: 'cannot delete' } }, false);
      }
      return jsonResponse({ success: true, data: { servers: [] } });
    });

    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'codex', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteServer(makeServer() as unknown as ProviderMcpServer);
    });

    expect(result.current.deleteError).toBe('cannot delete');
    expect(result.current.saveStatus).toBe('error');
  });

  it('submits the global form, clearing cache across all providers on success', async () => {
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/providers/mcp/servers/global' && init?.method === 'POST') {
        return jsonResponse({
          success: true,
          data: { results: [{ provider: 'claude', created: true }, { provider: 'codex', created: true }] },
        });
      }
      return jsonResponse({ success: true, data: { servers: [] } });
    });

    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'claude', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.openGlobalForm());

    await act(async () => {
      await result.current.submitGlobalForm({
        name: 'global-server',
        scope: 'user',
        workspacePath: '',
        transport: 'stdio',
        command: 'run',
        args: [],
        env: {},
        cwd: '',
        url: '',
        headers: {},
        envVars: [],
        bearerTokenEnvVar: '',
        envHttpHeaders: {},
        importMode: 'form',
        jsonInput: '',
      });
    });

    expect(result.current.isGlobalFormOpen).toBe(false);
    expect(result.current.saveStatus).toBe('success');
  });

  it('throws with per-provider failure details when a global add partially fails', async () => {
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/providers/mcp/servers/global' && init?.method === 'POST') {
        return jsonResponse({
          success: true,
          data: { results: [{ provider: 'codex', created: false, error: 'nope' }] },
        });
      }
      return jsonResponse({ success: true, data: { servers: [] } });
    });

    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'claude', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const caughtRef: { current: Error | null } = { current: null };
    // Catch inside `act` so React flushes the `setSaveStatus('error')` call
    // that happens synchronously right before the throw; letting the
    // rejection propagate out of `act` skips that flush.
    await act(async () => {
      try {
        await result.current.submitGlobalForm({
          name: 'global-server',
          scope: 'user',
          workspacePath: '',
          transport: 'stdio',
          command: 'run',
          args: [],
          env: {},
          cwd: '',
          url: '',
          headers: {},
          envVars: [],
          bearerTokenEnvVar: '',
          envHttpHeaders: {},
          importMode: 'form',
          jsonInput: '',
        });
      } catch (error) {
        caughtRef.current = error as Error;
      }
    });

    expect(caughtRef.current?.message).toMatch(/Codex: nope/);
    expect(result.current.saveStatus).toBe('error');
  });

  it('rejects a global submission with local scope', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse({ success: true, data: { servers: [] } }));
    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'claude', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      act(async () => {
        await result.current.submitGlobalForm({
          name: 'x',
          scope: 'local',
          workspacePath: '',
          transport: 'stdio',
          command: 'run',
          args: [],
          env: {},
          cwd: '',
          url: '',
          headers: {},
          envVars: [],
          bearerTokenEnvVar: '',
          envHttpHeaders: {},
          importMode: 'form',
          jsonInput: '',
        });
      }),
    ).rejects.toThrow('Add MCP Server supports only user or project scope across all providers.');
  });

  it('resets form/save state whenever the selected provider changes', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse({ success: true, data: { servers: [] } }));
    const { result, rerender } = renderHook(
      ({ provider }: { provider: McpProvider }) => useMcpServers({ selectedProvider: provider, currentProjects: EMPTY_PROJECTS }),
      { initialProps: { provider: 'claude' } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.openForm());
    expect(result.current.isFormOpen).toBe(true);

    rerender({ provider: 'codex' as const });

    expect(result.current.isFormOpen).toBe(false);
    expect(result.current.editingServer).toBeNull();
  });

  it('auto-clears saveStatus after a delay using fake timers', async () => {
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ success: true, data: { removed: true } });
      }
      return jsonResponse({ success: true, data: { servers: [] } });
    });

    // Load with real timers first: combining `waitFor` polling with fake timers
    // (especially `shouldAdvanceTime`) can spin indefinitely and exhaust the heap.
    const { result } = renderHook(() => useMcpServers({ selectedProvider: 'codex', currentProjects: EMPTY_PROJECTS }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Switch to fake timers before triggering the delete so the `setTimeout`
    // scheduled by the saveStatus-clearing effect is captured by the fake clock
    // (a timer registered under real timers can't be advanced afterwards).
    vi.useFakeTimers();

    await act(async () => {
      await result.current.deleteServer(makeServer() as unknown as ProviderMcpServer);
    });
    expect(result.current.saveStatus).toBe('success');

    act(() => {
      vi.advanceTimersByTime(2100);
    });

    expect(result.current.saveStatus).toBeNull();
  });
});
