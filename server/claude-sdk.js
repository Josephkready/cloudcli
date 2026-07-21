/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeUserContent, normalizeImageDescriptors } from './shared/image-attachments.js';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

// Default to waiting indefinitely for a tool-approval decision (0 = no timeout),
// matching a plain terminal `claude`, which never auto-denies. The old 55s
// auto-deny fired mid-task when the user hadn't approved in time — halting the
// agent and forcing a manual "continue" — a cloudcli-only divergence from the
// terminal (#62). Blocked-on-approval runs are now surfaced in the sidebar (#50)
// and the run is abortable, so an unanswered prompt just stays pending (the same
// behavior the interactive AskUserQuestion/ExitPlanMode tools already used). Set
// CLAUDE_TOOL_APPROVAL_TIMEOUT_MS to a positive value to restore a finite
// auto-deny timeout.
// Parse a millisecond env override, warning (rather than silently falling back)
// on a malformed non-empty value so a typo in e.g. CLAUDE_TOOL_APPROVAL_TIMEOUT_MS
// doesn't quietly restore indefinite waiting with no signal to the operator.
function parseMsEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  // Number() (not parseInt) so typos like "45m" or "10abc" become NaN and warn,
  // rather than parseInt silently truncating them to a bogus millisecond value.
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`[WARN] ${name}="${raw}" is not a valid non-negative integer (ms); using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

const TOOL_APPROVAL_TIMEOUT_MS = parseMsEnv('CLAUDE_TOOL_APPROVAL_TIMEOUT_MS', 0);

// Background safety net for runs abandoned mid-approval (#86). Since #62 removed
// the 55s auto-deny, a run blocked on an unanswered approval whose client never
// reconnects would stay resident forever (idle `claude` child + ChatRun +
// pending entry): it never reaches `completed`, so `evictRunLater` never frees
// it. The reaper force-denies approvals idle past a very generous window
// (default 45 min — far beyond any legitimate "reading the diff" pause, so it
// never reintroduces the #62 mid-task halt), letting the run finish and evict.
// Set CLAUDE_TOOL_APPROVAL_REAP_MS=0 to disable.
const STALE_APPROVAL_REAP_MS = parseMsEnv('CLAUDE_TOOL_APPROVAL_REAP_MS', 45 * 60 * 1000);
const STALE_APPROVAL_REAP_INTERVAL_MS = 5 * 60 * 1000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

/**
 * Selects pending tool approvals idle for at least `thresholdMs`, keyed off the
 * `_receivedAt` timestamp stored with each resolver. Pure over the passed map so
 * the reap policy is unit-testable in isolation; a non-positive threshold
 * disables reaping (returns []).
 * @param {Map<string, Function>} pendingMap
 * @param {number} now - current epoch ms
 * @param {number} thresholdMs - idle window before an approval is reapable
 * @returns {Array<{requestId: string, sessionId: string|null, toolName: string|null, idleMs: number}>}
 */
function findStaleToolApprovals(pendingMap, now, thresholdMs) {
  const stale = [];
  if (!(thresholdMs > 0)) {
    return stale;
  }
  for (const [requestId, resolver] of pendingMap.entries()) {
    const receivedAt = resolver?._receivedAt instanceof Date ? resolver._receivedAt.getTime() : NaN;
    if (Number.isFinite(receivedAt) && now - receivedAt >= thresholdMs) {
      stale.push({
        requestId,
        sessionId: resolver._sessionId ?? null,
        toolName: resolver._toolName ?? null,
        idleMs: now - receivedAt,
      });
    }
  }
  return stale;
}

/**
 * Force-denies tool approvals idle past the reap window. Denying (not aborting)
 * reuses the existing null-deny path — the same one waitForToolApproval's own
 * auto-deny timeout uses: the tool is rejected, the agent finishes its turn
 * naturally, and the run reaches `completed` so the registry evicts it.
 * Calling abortClaudeSDKSession here would instead suppress the terminal
 * `complete` (that signal is the chat.abort handler's job), leaving the run stuck.
 * @returns {number} how many approvals were reaped
 */
function reapStaleToolApprovals(now = Date.now(), thresholdMs = STALE_APPROVAL_REAP_MS) {
  const stale = findStaleToolApprovals(pendingToolApprovals, now, thresholdMs);
  for (const { requestId, sessionId, toolName, idleMs } of stale) {
    console.warn(
      `[approval reaper] Force-denying tool approval ${requestId} (${toolName ?? 'unknown'}) `
      + `for session ${sessionId ?? 'unknown'} after ${Math.round(idleMs / 60000)} min idle`,
    );
    resolveToolApproval(requestId, null);
  }
  return stale.length;
}

let staleApprovalReaperTimer = null;

/**
 * Starts the periodic stale-approval reaper. No-op when disabled
 * (CLAUDE_TOOL_APPROVAL_REAP_MS=0) or already running.
 */
function startStaleToolApprovalReaper(intervalMs = STALE_APPROVAL_REAP_INTERVAL_MS) {
  if (staleApprovalReaperTimer || !(STALE_APPROVAL_REAP_MS > 0)) {
    return;
  }
  staleApprovalReaperTimer = setInterval(() => {
    try {
      reapStaleToolApprovals();
    } catch (error) {
      console.error('[approval reaper] Error while reaping stale approvals:', error?.message || error);
    }
  }, intervalMs);
  // Don't keep the event loop alive just for the reaper.
  staleApprovalReaperTimer.unref?.();
}

/** Stops the reaper (used on shutdown and in tests). */
function stopStaleToolApprovalReaper() {
  if (staleApprovalReaperTimer) {
    clearInterval(staleApprovalReaperTimer);
    staleApprovalReaperTimer = null;
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 */
function addSession(sessionId, queryInstance, writer = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Assembles the token-budget payload sent to the client.
 *
 * `inputTokens` is expected to already include the cache creation/read tokens:
 * the Anthropic usage payload reports `input_tokens` as the tokens that were
 * *neither* read from nor written to the prompt cache, so the three counters are
 * disjoint and summing them is the context-window occupancy (not a double
 * count). Both extraction branches funnel through here so they can never drift
 * into reporting different shapes or different totals for the same run.
 *
 * @param {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number}} counts
 * @returns {Object} Token budget object
 */
function buildTokenBudget({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }) {
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens: cacheReadTokens + cacheCreationTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);

    return buildTokenBudget({
      inputTokens: directInputTokens + cacheCreationTokens + cacheReadTokens,
      outputTokens: readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens),
      cacheReadTokens,
      cacheCreationTokens,
    });
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages carrying only `modelUsage`.
  //
  // Every model entry is summed rather than reading `Object.keys(...)[0]`: a run
  // that delegated to a subagent records one entry per model, so reading only the
  // first reported whichever model happened to be inserted first (often the small
  // subagent model) as the entire run's usage.
  //
  // Cache tokens are folded into `inputTokens` exactly as the `usage` branch
  // above does. They occupy the context window all the same, so leaving them out
  // made the same run report a wildly smaller `used` purely based on which branch
  // the SDK message happened to hit.
  const modelEntries = Object.values(sdkMessage.modelUsage)
    .filter((entry) => Boolean(entry) && typeof entry === 'object');

  if (modelEntries.length === 0) {
    return null;
  }

  let directInputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  for (const modelData of modelEntries) {
    directInputTokens += readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
    outputTokens += readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
    cacheCreationTokens += readNumber(modelData.cacheCreationInputTokens ?? modelData.cacheCreationTokens);
    cacheReadTokens += readNumber(modelData.cacheReadInputTokens ?? modelData.cacheReadTokens);
  }

  return buildTokenBudget({
    inputTokens: directInputTokens + cacheCreationTokens + cacheReadTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });
}

/**
 * Builds the SDK `prompt` payload for one turn.
 *
 * Plain text turns pass the string through unchanged. Turns with image
 * attachments use the SDK's streaming-input mode: a single SDKUserMessage
 * whose content carries the prompt text plus one base64 `image` block per
 * attachment (read from the global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {string} cwd - Project working directory image paths resolve against
 * @returns {Promise<string|AsyncIterable>} SDK prompt payload
 */
async function buildPromptPayload(command, images, cwd) {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }

  const content = await buildClaudeUserContent(command, images, cwd);
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString()
    };
  })();
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

// The Claude CLI auto-updates itself in the background; during the brief window
// where it swaps the `claude` bin symlink, spawn() can hit ENOENT and the SDK
// surfaces "native binary not found". These bound a one-shot retry of the spawn
// so a single racy turn doesn't surface as a hard error (#43).
const CLAUDE_SPAWN_MAX_ATTEMPTS = 2;
const CLAUDE_SPAWN_RETRY_DELAY_MS = 600;

/**
 * True when an error looks like the `claude` binary briefly disappearing
 * (auto-updater symlink swap, an npm reinstall, ...) rather than a genuine
 * failure — an ENOENT spawn error or the SDK's "native binary not found".
 * @param {unknown} error
 * @returns {boolean}
 */
function isSpawnRaceError(error) {
  if (!error) {
    return false;
  }
  const message = typeof error.message === 'string' ? error.message : String(error);
  // The SDK's own message when the `claude` bin can't be resolved at launch.
  if (/native binary not found/i.test(message)) {
    return true;
  }
  // A spawn-time ENOENT (the executable vanished mid-launch), distinguished by
  // its syscall from an unrelated file-I/O ENOENT (e.g. reading a missing file),
  // which must not be mistaken for a spawn race.
  const syscall = typeof error.syscall === 'string' ? error.syscall : '';
  return error.code === 'ENOENT' && syscall.startsWith('spawn');
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      sessionId,
      options.model,
    );
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = (await providerModelsService.getProviderModels('claude')).models;
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Turns with image attachments switch to streaming input so the images
    // ride along as real content blocks. Built per query attempt because an
    // async generator cannot be replayed once consumed.
    const createPrompt = () => buildPromptPayload(command, options.images, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      // Mark the run blocked so the sidebar ranks it "needs attention" while it
      // waits on the user. By default the wait is indefinite (terminal parity,
      // #62): interaction tools always (timeoutMs:0), and other tools via
      // TOOL_APPROVAL_TIMEOUT_MS, which now defaults to 0 (no auto-deny) but can
      // be set to a positive value to restore a finite timeout. The finally
      // clears the blocked flag on every exit (allow/deny/timeout/cancel/abort).
      ws.setBlocked?.(true);
      let decision;
      try {
        decision = await waitForToolApproval(requestId, {
          timeoutMs: requiresInteraction ? 0 : undefined,
          signal: context?.signal,
          metadata: {
            _sessionId: capturedSessionId || sessionId || null,
            _toolName: toolName,
            _input: input,
            _receivedAt: new Date(),
          },
          onCancel: (reason) => {
            ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          }
        });
      } finally {
        ws.setBlocked?.(false);
      }
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Whether the SDK stream has yielded anything yet. A spawn race fails
    // immediately (nothing streamed), so it is only safe to retry the spawn
    // while this is false — never mid-stream.
    let anyOutputEmitted = false;

    // Build and fully drain the SDK generator once. Recreates the prompt and
    // query on each call because a consumed async generator cannot be replayed.
    const runQueryOnce = async () => {
      // Query constructor reads this synchronously.
      const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

      let queryInstance;
      try {
        queryInstance = query({
          prompt: await createPrompt(),
          options: sdkOptions
        });
      } catch (hookError) {
        // Older/newer SDK versions may not accept hook shapes yet.
        // Keep notification behavior operational via runtime events even if hook registration fails.
        console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
        delete sdkOptions.hooks;
        queryInstance = query({
          prompt: await createPrompt(),
          options: sdkOptions
        });
      }

      // Restore immediately — Query constructor already captured the value
      if (prevStreamTimeout !== undefined) {
        process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
      } else {
        delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      }

      // Track the query instance for abort capability
      if (capturedSessionId) {
        addSession(capturedSessionId, queryInstance, ws);
      }

      // Process streaming messages
      console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
      for await (const message of queryInstance) {
        // The spawn succeeded and the stream is live; past here a failure must
        // never trigger a spawn retry (it would duplicate already-sent output).
        anyOutputEmitted = true;

        // Capture session ID from first message
        if (message.session_id && !capturedSessionId) {

          capturedSessionId = message.session_id;
          addSession(capturedSessionId, queryInstance, ws);

          // Set session ID on writer
          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          // Send session-created event only once for new sessions
          if (!sessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
          }
        } else {
          // session_id already captured
        }

        // Transform and normalize message via adapter
        const transformedMessage = transformMessage(message);
        const sid = capturedSessionId || sessionId || null;

        // Use adapter to normalize SDK events into NormalizedMessage[]
        const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
        for (const msg of normalized) {
          // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
          if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
            msg.parentToolUseId = transformedMessage.parentToolUseId;
          }
          ws.send(msg);
        }

        // Extract and send token budget updates from assistant/result usage payloads
        const tokenBudgetData = extractTokenBudget(message);
        if (tokenBudgetData) {
          ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      }
    };

    // Retry the spawn once if it races the Claude CLI's background auto-updater
    // (a transient ENOENT while the bin symlink is swapped). Only before any
    // output — see anyOutputEmitted — so a live stream is never restarted.
    for (let spawnAttempt = 1; ; spawnAttempt++) {
      try {
        await runQueryOnce();
        break;
      } catch (error) {
        if (!(spawnAttempt < CLAUDE_SPAWN_MAX_ATTEMPTS && !anyOutputEmitted && isSpawnRaceError(error))) {
          throw error;
        }
        console.warn(`[Claude SDK] Claude spawn raced the CLI auto-updater (attempt ${spawnAttempt}/${CLAUDE_SPAWN_MAX_ATTEMPTS}); retrying in ${CLAUDE_SPAWN_RETRY_DELAY_MS}ms:`, error?.message || error);
        await new Promise((resolve) => setTimeout(resolve, CLAUDE_SPAWN_RETRY_DELAY_MS));
        // The run can be aborted while we sleep. `chat.abort` always completes
        // the run in the registry (regardless of provider-session id or whether
        // interrupt() succeeded), which flips `isRunActive()` to false — a more
        // reliable signal than abortedSessionIds. Bail rather than start a fresh
        // stream into a session the client already believes is finished; the
        // outer catch suppresses the error for aborted runs.
        if (ws?.isRunActive?.() === false) {
          throw error;
        }
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    if (!wasAborted) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : 'completed'
    });
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await providerAuthService.isProviderInstalled('claude');
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  waitForToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  isSpawnRaceError,
  parseMsEnv,
  extractTokenBudget,
  mapCliOptionsToSDK,
  findStaleToolApprovals,
  reapStaleToolApprovals,
  startStaleToolApprovalReaper,
  stopStaleToolApprovalReaper
};
