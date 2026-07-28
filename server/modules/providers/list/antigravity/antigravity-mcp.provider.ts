import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

export class AntigravityMcpProvider extends McpProvider {
  constructor() {
    super('antigravity', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const filePath = this.getConfigPath(scope, workspacePath);
    const config = await readJsonConfig(filePath);
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = this.getConfigPath(scope, workspacePath);
    const config = await readJsonConfig(filePath);
    config.mcpServers = servers;
    await writeJsonConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      const command = input.command?.trim();
      if (!command) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }
      return {
        command,
        args: input.args ?? [],
        env: input.env ?? {},
        ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
      };
    }

    const serverUrl = input.url?.trim();
    if (!serverUrl) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }
    return {
      serverUrl,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    const command = readOptionalString(config.command);
    if (command) {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'stdio',
        command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
      };
    }

    const url = readOptionalString(config.serverUrl) ?? readOptionalString(config.url);
    if (url) {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'http',
        url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }

  private getConfigPath(scope: McpScope, workspacePath: string): string {
    return scope === 'user'
      ? path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')
      : path.join(workspacePath, '.agents', 'mcp_config.json');
  }
}
