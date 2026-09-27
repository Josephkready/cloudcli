import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { getApiErrorMessage, toResponseJson } from '../../../utils/apiResponse';
import { MCP_SUPPORTED_SCOPES } from '../constants';
import type {
  ApiResponse,
  McpProject,
  McpProvider,
  McpScope,
  McpTransport,
  ProviderMcpServer,
} from '../types';
import {
  getErrorMessage,
  getProjectPath,
  isMcpScope,
  isMcpTransport,
} from '../utils/mcpFormatting';

type ProviderMcpServerResponse = {
  provider: McpProvider;
  scope: McpScope;
  servers: Array<Partial<ProviderMcpServer>>;
};

// Internal MCP-side shape; `name` is now filled from the DB projectId since
// the legacy Project.name field was removed during the projectId migration.
type ProjectTarget = {
  name: string;
  displayName: string;
  path: string;
};

type McpServersCacheEntry = {
  servers: ProviderMcpServer[];
  updatedAt: number;
};

type ScopedProjectRequest = {
  scope: McpScope;
  project: ProjectTarget;
};

const MCP_CACHE_TTL_MS = 30_000;
const mcpServersCache = new Map<string, McpServersCacheEntry>();

// Settings users often switch between provider tabs repeatedly. A short module
// cache prevents those tab switches from refetching every project config file.

const normalizeTransport = (value: unknown, fallback: McpTransport = 'stdio'): McpTransport => (
  isMcpTransport(value) ? value : fallback
);

const normalizeScope = (value: unknown, fallback: McpScope): McpScope => (
  isMcpScope(value) ? value : fallback
);

const normalizeServer = (
  provider: McpProvider,
  scope: McpScope,
  server: Partial<ProviderMcpServer>,
  project?: ProjectTarget,
): ProviderMcpServer => {
  const transport = normalizeTransport(server.transport, server.url ? 'http' : 'stdio');
  return {
    provider,
    name: String(server.name ?? ''),
    scope: normalizeScope(server.scope, scope),
    transport,
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
    cwd: server.cwd,
    url: server.url,
    headers: server.headers ?? {},
    envVars: server.envVars ?? [],
    bearerTokenEnvVar: server.bearerTokenEnvVar,
    envHttpHeaders: server.envHttpHeaders ?? {},
    workspacePath: project?.path || server.workspacePath,
    // Keep the `projectName` key in the MCP wire payload for backwards
    // compatibility. ProjectTarget.name is populated from the DB `projectId`
    // (see createProjectTargets) so this still carries the new identifier.
    projectName: project?.name || server.projectName,
    projectDisplayName: project?.displayName || server.projectDisplayName,
  };
};

const createProjectTargets = (projects: McpProject[]): ProjectTarget[] => {
  const seen = new Set<string>();
  return projects.reduce<ProjectTarget[]>((acc, project) => {
    const projectPath = getProjectPath(project);
    if (!projectPath || seen.has(projectPath)) {
      return acc;
    }

    seen.add(projectPath);
    acc.push({
      // Use projectId as the stable internal identifier.
      name: project.projectId,
      displayName: project.displayName || project.projectId,
      path: projectPath,
    });
    return acc;
  }, []);
};

const fetchProviderScopeServers = async (
  provider: McpProvider,
  scope: McpScope,
  project?: ProjectTarget,
): Promise<ProviderMcpServer[]> => {
  const params = new URLSearchParams({ scope });
  if (project?.path) {
    params.set('workspacePath', project.path);
  }

  const response = await authenticatedFetch(`/api/providers/${provider}/mcp/servers?${params.toString()}`);
  const data = await toResponseJson<ApiResponse<ProviderMcpServerResponse>>(response);

  if (!response.ok || !data.success) {
    throw new Error(getApiErrorMessage(data, `Failed to load ${provider} MCP servers`));
  }

  return (data.data.servers || []).map((server) => normalizeServer(provider, scope, server, project));
};

const deleteProviderServer = async (
  provider: McpProvider,
  server: ProviderMcpServer,
): Promise<void> => {
  const params = new URLSearchParams({ scope: server.scope });
  if (server.workspacePath) {
    params.set('workspacePath', server.workspacePath);
  }

  const response = await authenticatedFetch(
    `/api/providers/${provider}/mcp/servers/${encodeURIComponent(server.name)}?${params.toString()}`,
    { method: 'DELETE' },
  );
  const data = await toResponseJson<ApiResponse<{ removed: boolean }>>(response);

  if (!response.ok || !data.success) {
    throw new Error(getApiErrorMessage(data, 'Failed to delete MCP server'));
  }
};

const getServerIdentity = (server: ProviderMcpServer): string => (
  `${server.provider}:${server.scope}:${server.workspacePath || 'global'}:${server.name}`
);

const getCacheKey = (provider: McpProvider, projects: ProjectTarget[]): string => {
  const projectKey = projects.map((project) => project.path).sort().join('|');
  return `${provider}:${projectKey}`;
};

const sortServers = (servers: ProviderMcpServer[]): ProviderMcpServer[] => {
  const scopeOrder: Record<McpScope, number> = {
    user: 0,
    project: 1,
    local: 2,
  };

  return [...servers].sort((left, right) => {
    const scopeDelta = scopeOrder[left.scope] - scopeOrder[right.scope];
    if (scopeDelta !== 0) {
      return scopeDelta;
    }

    const projectDelta = (left.projectDisplayName || '').localeCompare(right.projectDisplayName || '');
    if (projectDelta !== 0) {
      return projectDelta;
    }

    return left.name.localeCompare(right.name);
  });
};

const mergeServers = (
  existingServers: ProviderMcpServer[],
  incomingServers: ProviderMcpServer[],
): ProviderMcpServer[] => {
  const serversById = new Map<string, ProviderMcpServer>();
  existingServers.forEach((server) => {
    serversById.set(getServerIdentity(server), server);
  });
  incomingServers.forEach((server) => {
    serversById.set(getServerIdentity(server), server);
  });

  return sortServers([...serversById.values()]);
};

const replaceScopedServers = (
  existingServers: ProviderMcpServer[],
  incomingServers: ProviderMcpServer[],
  scope: McpScope,
  workspacePath?: string,
): ProviderMcpServer[] => {
  const remainingServers = existingServers.filter((server) => (
    server.scope !== scope || (server.workspacePath || '') !== (workspacePath || '')
  ));

  return mergeServers(remainingServers, incomingServers);
};

type UseMcpServersArgs = {
  selectedProvider: McpProvider;
  currentProjects: McpProject[];
};

export function useMcpServers({ selectedProvider, currentProjects }: UseMcpServersArgs) {
  const [servers, setServers] = useState<ProviderMcpServer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [isLoadingProjectScopes, setIsLoadingProjectScopes] = useState(false);
  const activeLoadIdRef = useRef(0);

  const projectTargets = useMemo(() => createProjectTargets(currentProjects), [currentProjects]);
  const cacheKey = useMemo(() => getCacheKey(selectedProvider, projectTargets), [projectTargets, selectedProvider]);

  const refreshServers = useCallback(async (options: { force?: boolean } = {}) => {
    const loadId = activeLoadIdRef.current + 1;
    activeLoadIdRef.current = loadId;

    const cachedEntry = mcpServersCache.get(cacheKey);
    const canUseCache = !options.force && cachedEntry && Date.now() - cachedEntry.updatedAt < MCP_CACHE_TTL_MS;
    if (canUseCache) {
      setServers(cachedEntry.servers);
      setIsLoading(false);
      setIsLoadingProjectScopes(false);
      setLoadError(null);
      return;
    }

    if (cachedEntry && !options.force) {
      setServers(cachedEntry.servers);
    } else {
      setServers([]);
    }

    setIsLoading(!cachedEntry);
    setIsLoadingProjectScopes(false);
    setLoadError(null);

    const supportedScopes = MCP_SUPPORTED_SCOPES[selectedProvider];
    let nextServers: ProviderMcpServer[] = cachedEntry && !options.force ? cachedEntry.servers : [];
    let firstError: string | null = null;

    // Load the global/user scope first so the visible list can paint quickly.
    // Project and local scopes can involve many project config files, so they
    // are appended below as background requests instead of blocking this render.
    if (supportedScopes.includes('user')) {
      try {
        const userServers = await fetchProviderScopeServers(selectedProvider, 'user');
        if (activeLoadIdRef.current !== loadId) {
          return;
        }

        nextServers = replaceScopedServers(nextServers, userServers, 'user');
        setServers(sortServers(nextServers));
      } catch (error) {
        firstError = getErrorMessage(error);
      }
    }

    if (activeLoadIdRef.current !== loadId) {
      return;
    }

    setIsLoading(false);

    const projectScopeRequests: ScopedProjectRequest[] = [];
    projectTargets.forEach((project) => {
      if (supportedScopes.includes('project')) {
        projectScopeRequests.push({ scope: 'project', project });
      }

      if (supportedScopes.includes('local')) {
        projectScopeRequests.push({ scope: 'local', project });
      }
    });

    if (projectScopeRequests.length === 0) {
      const finalServers = sortServers(nextServers);
      mcpServersCache.set(cacheKey, { servers: finalServers, updatedAt: Date.now() });
      setLoadError(firstError);
      return;
    }

    setIsLoadingProjectScopes(true);

    // Update the UI as each project scope resolves. This avoids waiting for the
    // slowest project before showing servers from faster config files.
    await Promise.all(projectScopeRequests.map(async ({ scope, project }) => {
      try {
        const scopedServers = await fetchProviderScopeServers(selectedProvider, scope, project);
        if (activeLoadIdRef.current !== loadId) {
          return;
        }

        nextServers = replaceScopedServers(nextServers, scopedServers, scope, project.path);
        setServers(nextServers);
      } catch (error) {
        firstError = firstError || getErrorMessage(error);
      }
    }));

    if (activeLoadIdRef.current !== loadId) {
      return;
    }

    const finalServers = sortServers(nextServers);
    mcpServersCache.set(cacheKey, { servers: finalServers, updatedAt: Date.now() });
    setServers(finalServers);
    setLoadError(firstError);
    setIsLoadingProjectScopes(false);
  }, [cacheKey, projectTargets, selectedProvider]);

  const deleteServer = useCallback(
    async (server: ProviderMcpServer) => {
      if (!window.confirm('Are you sure you want to delete this MCP server?')) {
        return;
      }

      setDeleteError(null);
      try {
        await deleteProviderServer(selectedProvider, server);
        mcpServersCache.delete(cacheKey);
        await refreshServers({ force: true });
        setSaveStatus('success');
      } catch (error) {
        setDeleteError(getErrorMessage(error));
        setSaveStatus('error');
      }
    },
    [cacheKey, refreshServers, selectedProvider],
  );

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  useEffect(() => {
    setDeleteError(null);
    setSaveStatus(null);
  }, [selectedProvider]);

  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  return {
    servers,
    isLoading,
    isLoadingProjectScopes,
    loadError,
    deleteError,
    saveStatus,
    deleteServer,
    refreshServers,
  };
}
