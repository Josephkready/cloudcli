import type { ChildProcess } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { isShutdownDraining } from '@/shared/shutdown-drain.js';
import type { NormalizedMessage, ProviderModelsDefinition } from '@/shared/types.js';
import {
  buildProviderCliEnv,
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  resolveProviderCliExecutable,
} from '@/shared/utils.js';

/** `agy`'s permission-mode flag names, mirroring claude/codex's shared vocabulary. */
type AntigravityPermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

/**
 * Minimal writer surface `spawnAntigravity` needs from its caller (the real
 * implementation is `ChatSessionWriter`). Kept local rather than importing the
 * concrete class so this runner stays a plain module with no websocket-layer
 * dependency.
 */
type AntigravityRunWriter = {
  userId?: string | number | null;
  send(message: NormalizedMessage): void;
  setSessionId?(sessionId: string): void;
  setAbortHandler?(handler: () => boolean | Promise<boolean>): void;
  clearAbortHandler?(): void;
};

type SpawnAntigravityOptions = {
  sessionId?: string | null;
  projectPath?: string;
  cwd?: string;
  model?: string;
  effort?: unknown;
  sessionSummary?: string;
  permissionMode?: AntigravityPermissionMode;
};

/** A tracked `agy` child process, tagged with abort state once cancellation begins. */
type AntigravityChildProcess = ChildProcess & { aborted?: boolean };

const activeAntigravityProcesses = new Map<string, AntigravityChildProcess>();
const abortEscalationTimers = new WeakMap<AntigravityChildProcess, ReturnType<typeof setTimeout>>();
const ANTIGRAVITY_ABORT_GRACE_MS = 5000;

/**
 * Ask a live Antigravity child to stop, then force-kill it if SIGTERM is
 * ignored. The timer retains the child until it exits, so it cannot become an
 * untracked orphan during shutdown/abort cleanup.
 */
export function terminateAntigravityChild(
  child: AntigravityChildProcess,
  graceMs: number = ANTIGRAVITY_ABORT_GRACE_MS,
): boolean {
  child.aborted = true;
  if (abortEscalationTimers.has(child)) {
    return true;
  }

  const clearEscalation = () => {
    const timer = abortEscalationTimers.get(child);
    if (timer) {
      clearTimeout(timer);
      abortEscalationTimers.delete(child);
    }
  };
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch (error) {
      console.error('[Antigravity] Failed to force-kill aborted process:', (error as Error)?.message || error);
    }
  }, graceMs);
  timer.unref?.();
  abortEscalationTimers.set(child, timer);
  child.once('close', clearEscalation);

  try {
    const signalled = child.kill('SIGTERM');
    if (!signalled) {
      clearEscalation();
    }
    return signalled;
  } catch (error) {
    clearEscalation();
    console.error('[Antigravity] Failed to terminate process:', (error as Error)?.message || error);
    return false;
  }
}
const MAX_PROVIDER_ERROR_LENGTH = 2_000;

function sanitizeAntigravityError(value: unknown): string {
  const message = readString(value) || 'Antigravity CLI failed';
  return message
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(
      /([?&](?:access_token|api[_-]?key|key|password|secret|token)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b((?:access[_-]?token|api[_-]?key|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .slice(0, MAX_PROVIDER_ERROR_LENGTH);
}

export function resolveAntigravityPermissionArgs(permissionMode?: AntigravityPermissionMode | string): string[] {
  switch (permissionMode) {
    case 'plan':
      return ['--mode', 'plan'];
    case 'acceptEdits':
      return ['--mode', 'accept-edits'];
    case 'bypassPermissions':
      return ['--dangerously-skip-permissions'];
    default:
      return [];
  }
}

/**
 * The effort tier to pass to `agy --effort`, or `undefined` to let `agy` decide.
 *
 * `agy` rejects an effort the chosen model does not offer, so the requested tier
 * is only accepted when the model's catalog entry lists it. Mirrors
 * `resolveClaudeEffort`/codex: the synthetic `'default'` and any unknown tier
 * fall through to `undefined`.
 *
 * @param model - the resolved base model (e.g. `gemini-3.8-flash`)
 * @param effort - the requested tier
 * @param modelsDefinition - the provider's model catalog
 */
export function resolveAntigravityEffort(
  model: string | undefined,
  effort: unknown,
  modelsDefinition: Pick<ProviderModelsDefinition, 'OPTIONS'> | null | undefined,
): string | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * One decoded line of `agy`'s `--output-format stream-json` NDJSON stream.
 * Left loosely typed (SDK/CLI boundary): the shape varies by `event`, and this
 * runner only ever reads a handful of optional fields off of it.
 */
type AntigravityStreamEvent = {
  event?: string;
  conversation_id?: unknown;
  init?: { conversation_id?: unknown };
  step_update?: { conversation_id?: unknown; text_delta?: unknown };
  result?: {
    conversation_id?: unknown;
    status?: string;
    error?: unknown;
    message?: unknown;
    response?: unknown;
  };
};

function readAgyStreamEvent(line: string): AntigravityStreamEvent | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed as AntigravityStreamEvent : null;
  } catch {
    return null;
  }
}

function getEventConversationId(event: AntigravityStreamEvent | null): string | null {
  return readString(event?.conversation_id)
    || readString(event?.init?.conversation_id)
    || readString(event?.step_update?.conversation_id)
    || readString(event?.result?.conversation_id);
}

function getEventTextDelta(event: AntigravityStreamEvent | null): string | null {
  const delta = event?.step_update?.text_delta;
  if (event?.event === 'step_update' && typeof delta === 'string' && delta.length > 0) {
    return delta;
  }
  return null;
}

function getResultError(event: AntigravityStreamEvent | null): string | null {
  if (event?.event !== 'result' || event?.result?.status === 'SUCCESS') {
    return null;
  }
  return sanitizeAntigravityError(readString(event?.result?.error)
    || readString(event?.result?.message)
    || `Antigravity run ended with status ${event?.result?.status || 'UNKNOWN'}`);
}

function announceConversation(writer: AntigravityRunWriter, conversationId: string | null, isResume: boolean): void {
  if (!conversationId) {
    return;
  }
  writer.setSessionId?.(conversationId);
  if (!isResume) {
    writer.send(createNormalizedMessage({
      kind: 'session_created',
      newSessionId: conversationId,
      sessionId: conversationId,
      provider: 'antigravity',
    }));
  }
}

/**
 * Runs one Antigravity CLI turn using its newline-delimited structured stream.
 */
export async function spawnAntigravity(
  command: string,
  options: SpawnAntigravityOptions = {},
  writer: AntigravityRunWriter,
): Promise<void> {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    effort,
    sessionSummary,
    permissionMode = 'default',
  } = options;
  const workingDirectory = cwd || projectPath || process.cwd();
  const resumeConversationId = readString(sessionId);
  const resolvedModel = await providerModelsService.resolveResumeModel(
    'antigravity',
    resumeConversationId ?? undefined,
    model,
  );

  // `agy` takes model and effort as separate flags but is strict: it rejects an
  // effort tier the chosen model does not offer (e.g. `gemini-3.1-pro --effort
  // medium`). So gate the requested tier against the model's catalog entry, the
  // same way claude/codex do — an unsupported or 'default' tier is omitted and
  // `agy` applies its own default. Only fetch the catalog when a real tier was
  // requested, so ordinary sends don't pay for it.
  let resolvedEffort: string | undefined;
  if (typeof effort === 'string' && effort !== 'default' && effort.length > 0) {
    const catalog = (await providerModelsService.getProviderModels('antigravity')).models;
    resolvedEffort = resolveAntigravityEffort(resolvedModel, effort, catalog);
  }

  const args: string[] = [];
  if (resumeConversationId) {
    args.push('--conversation', resumeConversationId);
  }
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }
  if (resolvedEffort) {
    args.push('--effort', resolvedEffort);
  }
  args.push(...resolveAntigravityPermissionArgs(permissionMode));
  // `--print` consumes the following argument as its prompt, so every other
  // flag must precede it.
  args.push('--output-format', 'stream-json');
  args.push('--print', flattenPromptForWindowsShell(command?.trim() || ''));

  return new Promise((resolve, reject) => {
    const child = crossSpawn(resolveProviderCliExecutable('ANTIGRAVITY_CLI_PATH', 'agy'), args, {
      cwd: workingDirectory,
      env: buildProviderCliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as AntigravityChildProcess;
    const processKeys = new Set<string>();
    let conversationId = resumeConversationId;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let emittedText = false;
    let terminalSent = false;
    let resultError: string | null = null;
    let settled = false;

    const registerProcessKey = (key: string | null | undefined) => {
      if (!key) {
        return;
      }
      processKeys.add(key);
      activeAntigravityProcesses.set(key, child);
    };
    registerProcessKey(resumeConversationId);

    const cleanup = () => {
      for (const key of processKeys) {
        if (activeAntigravityProcesses.get(key) === child) {
          activeAntigravityProcesses.delete(key);
        }
      }
    };

    const sendComplete = (exitCode: number, aborted = false) => {
      if (terminalSent) {
        return;
      }
      terminalSent = true;
      writer.send(createCompleteMessage({
        provider: 'antigravity',
        sessionId: conversationId,
        actualSessionId: conversationId,
        exitCode,
        aborted,
      }));
    };

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      const event = readAgyStreamEvent(trimmed);
      if (!event) {
        writer.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: `${line}\n`,
          sessionId: conversationId,
          provider: 'antigravity',
        }));
        emittedText = true;
        return;
      }

      const discoveredId = getEventConversationId(event);
      if (discoveredId && discoveredId !== conversationId) {
        conversationId = discoveredId;
        registerProcessKey(conversationId);
        announceConversation(writer, conversationId, Boolean(resumeConversationId));
      } else if (discoveredId && !processKeys.has(discoveredId)) {
        registerProcessKey(discoveredId);
      }

      const delta = getEventTextDelta(event);
      if (delta !== null) {
        emittedText = true;
        writer.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: delta,
          sessionId: conversationId,
          provider: 'antigravity',
        }));
      }

      const failure = getResultError(event);
      if (failure) {
        resultError = failure;
        writer.send(createNormalizedMessage({
          kind: 'error',
          content: failure,
          sessionId: conversationId,
          provider: 'antigravity',
        }));
      }

      if (event?.event === 'result' && !emittedText) {
        const response = readString(event?.result?.response);
        if (response) {
          emittedText = true;
          writer.send(createNormalizedMessage({
            kind: 'stream_delta',
            content: response,
            sessionId: conversationId,
            provider: 'antigravity',
          }));
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuffer.length < MAX_PROVIDER_ERROR_LENGTH * 2) {
        stderrBuffer += chunk.toString();
      }
    });

    child.on('error', async (error: Error) => {
      writer.clearAbortHandler?.();
      cleanup();
      if (settled) {
        return;
      }
      // A failed spawn can emit `close` while the installation check is
      // pending. Claim the terminal path synchronously so only this handler
      // reports the failure.
      settled = true;
      const installed = await providerAuthService.isProviderInstalled('antigravity');
      const content = installed
        ? sanitizeAntigravityError(error.message)
        : 'Antigravity CLI is not installed. Install it from https://antigravity.google/cli/install.sh';
      writer.send(createNormalizedMessage({
        kind: 'error',
        content,
        sessionId: conversationId,
        provider: 'antigravity',
      }));
      sendComplete(1);
      notifyRunFailed({
        userId: writer?.userId || null,
        provider: 'antigravity',
        sessionId: conversationId,
        sessionName: sessionSummary,
        error: new Error(content),
      });
      reject(error);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      writer.clearAbortHandler?.();
      cleanup();
      if (settled) {
        return;
      }
      settled = true;
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer);
      }

      // A bare SIGTERM during the shutdown drain is the server's own stop signal
      // reaching the child, not a user abort: report it as a failure so the run
      // registry keeps it resumable (#535). User aborts set `child.aborted`.
      const aborted = child.aborted === true || (signal === 'SIGTERM' && !isShutdownDraining());
      const stderr = sanitizeAntigravityError(stderrBuffer);
      const exitCode = aborted ? 1 : (code ?? 1);
      if (!aborted && stderr && exitCode !== 0 && !resultError) {
        resultError = stderr;
        writer.send(createNormalizedMessage({
          kind: 'error',
          content: stderr,
          sessionId: conversationId,
          provider: 'antigravity',
        }));
      }

      sendComplete(resultError ? 1 : exitCode, aborted);
      if (aborted) {
        notifyRunStopped({
          userId: writer?.userId || null,
          provider: 'antigravity',
          sessionId: conversationId,
          sessionName: sessionSummary,
          stopReason: 'aborted',
        });
        resolve();
        return;
      }

      if (exitCode === 0 && !resultError) {
        notifyRunStopped({
          userId: writer?.userId || null,
          provider: 'antigravity',
          sessionId: conversationId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        resolve();
        return;
      }

      const error = new Error(resultError || `Antigravity CLI exited with code ${exitCode}`);
      notifyRunFailed({
        userId: writer?.userId || null,
        provider: 'antigravity',
        sessionId: conversationId,
        sessionName: sessionSummary,
        error,
      });
      reject(error);
    });

    // Install only after the close/error paths are listening. If Stop arrived
    // before spawn completed, setAbortHandler invokes this immediately; the
    // listeners must already exist so a fast exit cannot strand the promise.
    writer.setAbortHandler?.(() => terminateAntigravityChild(child));
  });
}

export function abortAntigravitySession(sessionId: string): boolean {
  const child = activeAntigravityProcesses.get(sessionId);
  if (!child) {
    return false;
  }
  return terminateAntigravityChild(child);
}
