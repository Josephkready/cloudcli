import type { McpScope, McpTransport } from '../types';

export const maskSecret = (value: unknown): string => {
  const normalizedValue = String(value ?? '');
  if (normalizedValue.length <= 4) {
    return '****';
  }

  return `${normalizedValue.slice(0, 2)}****${normalizedValue.slice(-2)}`;
};

export const isMcpScope = (value: unknown): value is McpScope => (
  value === 'user' || value === 'local' || value === 'project'
);

export const isMcpTransport = (value: unknown): value is McpTransport => (
  value === 'stdio' || value === 'http' || value === 'sse'
);

export const getProjectPath = (project: { fullPath?: string; path?: string }): string => (
  project.fullPath || project.path || ''
);

export const getErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Unknown error'
);
