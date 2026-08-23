import crossSpawn from 'cross-spawn';

import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import {
  buildProviderCliEnv,
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  resolveProviderCliExecutable,
} from './shared/utils.js';

const activeAntigravityProcesses = new Map();
const abortEscalationTimers = new WeakMap();
const ANTIGRAVITY_ABORT_GRACE_MS = 5000;

/**
 * Ask a live Antigravity child to stop, then force-kill it if SIGTERM is
 * ignored. The timer retains the child until it exits, so it cannot become an
 * untracked orphan during shutdown/abort cleanup.
 */
export function terminateAntigravityChild(child, graceMs = ANTIGRAVITY_ABORT_GRACE_MS) {
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
      console.error('[Antigravity] Failed to force-kill aborted process:', error?.message || error);
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
    console.error('[Antigravity] Failed to terminate process:', error?.message || error);
    return false;
  }
}
const MAX_PROVIDER_ERROR_LENGTH = 2_000;

export function sanitizeAntigravityError(value) {
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

export function resolveAntigravityPermissionArgs(permissionMode) {
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

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readAgyStreamEvent(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getEventConversationId(event) {
  return readString(event?.conversation_id)
    || readString(event?.init?.conversation_id)
    || readString(event?.step_update?.conversation_id)
    || readString(event?.result?.conversation_id);
}

function getEventTextDelta(event) {
  const delta = event?.step_update?.text_delta;
  if (event?.event === 'step_update' && typeof delta === 'string' && delta.length > 0) {
    return delta;
  }
  return null;
}

function getResultError(event) {
  if (event?.event !== 'result' || event?.result?.status === 'SUCCESS') {
    return null;
  }
  return sanitizeAntigravityError(readString(event?.result?.error)
    || readString(event?.result?.message)
    || `Antigravity run ended with status ${event?.result?.status || 'UNKNOWN'}`);
}

function announceConversation(writer, conversationId, isResume) {
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
export async function spawnAntigravity(command, options = {}, writer) {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    sessionSummary,
    permissionMode = 'default',
  } = options;
  const workingDirectory = cwd || projectPath || process.cwd();
  const resumeConversationId = readString(sessionId);
  const resolvedModel = await providerModelsService.resolveResumeModel(
    'antigravity',
    resumeConversationId,
    model,
  );

  const args = [];
  if (resumeConversationId) {
    args.push('--conversation', resumeConversationId);
  }
  if (resolvedModel) {
    args.push('--model', resolvedModel);
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
    });
    const processKeys = new Set();
    let conversationId = resumeConversationId;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let emittedText = false;
    let terminalSent = false;
    let resultError = null;
    let settled = false;

    const registerProcessKey = (key) => {
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

    const sendComplete = (exitCode, aborted = false) => {
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

    const processLine = (line) => {
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

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBuffer.length < MAX_PROVIDER_ERROR_LENGTH * 2) {
        stderrBuffer += chunk.toString();
      }
    });

    child.on('error', async (error) => {
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

    child.on('close', (code, signal) => {
      writer.clearAbortHandler?.();
      cleanup();
      if (settled) {
        return;
      }
      settled = true;
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer);
      }

      const aborted = child.aborted === true || signal === 'SIGTERM';
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

export function abortAntigravitySession(sessionId) {
  const child = activeAntigravityProcesses.get(sessionId);
  if (!child) {
    return false;
  }
  return terminateAntigravityChild(child);
}

export function isAntigravitySessionActive(sessionId) {
  return activeAntigravityProcesses.has(sessionId);
}

export function getActiveAntigravitySessions() {
  return [...activeAntigravityProcesses.keys()];
}
