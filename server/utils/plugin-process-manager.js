import path from 'path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { scanPlugins, getPluginsConfig, getPluginDir } from './plugin-loader.js';

// Map<pluginName, { process, port }>
const runningPlugins = new Map();
// Map<pluginName, Promise<port>> — in-flight start operations
const startingPlugins = new Map();
// Map<pluginName, ChildProcess> — resources that exist before ready/port discovery.
const startingPluginProcesses = new Map();
const terminatingPluginProcesses = new WeakMap();
const PLUGIN_STOP_GRACE_MS = 5000;
let stoppingAllPlugins = false;

/**
 * Stop a plugin child with bounded grace. The escalation timer itself retains
 * the child until it exits or receives SIGKILL, including startup failures
 * that have not yet entered `runningPlugins`.
 */
export function terminatePluginProcess(pluginProcess, onSettled = () => {}, graceMs = PLUGIN_STOP_GRACE_MS) {
  const existing = terminatingPluginProcesses.get(pluginProcess);
  if (existing) {
    existing.callbacks.add(onSettled);
    return;
  }

  let settled = false;
  let forceKillTimer = null;
  const callbacks = new Set([onSettled]);
  const onExit = () => settle(true);
  const settle = (success = true) => {
    if (settled) return;
    settled = true;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    pluginProcess.removeListener('exit', onExit);
    terminatingPluginProcesses.delete(pluginProcess);
    for (const callback of callbacks) callback(success);
  };
  terminatingPluginProcesses.set(pluginProcess, { callbacks });

  pluginProcess.once('exit', onExit);
  try {
    const signalled = pluginProcess.kill('SIGTERM');
    if (!signalled) {
      console.error('[Plugins] Plugin process rejected SIGTERM');
      settle(false);
      return;
    }
  } catch (error) {
    console.error('[Plugins] Failed to terminate plugin process:', error?.message || error);
    settle(false);
    return;
  }

  if (settled) return;

  forceKillTimer = setTimeout(() => {
    if (settled) return;
    let signalled = false;
    try {
      signalled = pluginProcess.kill('SIGKILL');
      if (!signalled) {
        console.error('[Plugins] Plugin process rejected SIGKILL');
      }
    } catch (error) {
      console.error('[Plugins] Failed to force-kill plugin process:', error?.message || error);
    } finally {
      settle(signalled);
    }
  }, graceMs);
  forceKillTimer.unref?.();
}

/**
 * Build the environment handed to a plugin server subprocess.
 *
 * Intentionally minimal: only non-secret essentials, never the host's full
 * environment. On Windows a handful of system variables are required for any
 * child to bootstrap (Node itself, and any Python or CLI a plugin shells out
 * to). Without APPDATA a `pip install --user` tool cannot locate its
 * site-packages and fails to import; SystemRoot, PATHEXT and TEMP are needed to
 * resolve system DLLs, executable extensions and a temp directory. None of
 * these carry secrets, so the ones that are set get passed straight through.
 */
function buildPluginEnv(name) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV || 'production',
    PLUGIN_NAME: name,
  };

  if (process.platform === 'win32') {
    const WINDOWS_ESSENTIALS = [
      'SystemRoot', 'windir', 'SystemDrive',
      'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'TEMP', 'TMP', 'PATHEXT',
    ];
    for (const key of WINDOWS_ESSENTIALS) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
  }

  return env;
}

/**
 * Start a plugin's server subprocess.
 * The plugin's server entry must print a JSON line with { ready: true, port: <number> }
 * to stdout within 10 seconds.
 */
export function startPluginServer(name, pluginDir, serverEntry, spawnProcess = spawn) {
  if (stoppingAllPlugins) {
    return Promise.reject(new Error('Plugin shutdown is in progress'));
  }
  if (runningPlugins.has(name)) {
    return Promise.resolve(runningPlugins.get(name).port);
  }

  // Coalesce concurrent starts for the same plugin
  if (startingPlugins.has(name)) {
    return startingPlugins.get(name);
  }

  const startPromise = new Promise((resolve, reject) => {

    const serverPath = path.join(pluginDir, serverEntry);

    const pluginProcess = spawnProcess('node', [serverPath], {
      cwd: pluginDir,
      env: buildPluginEnv(name),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    startingPluginProcesses.set(name, pluginProcess);

    let resolved = false;
    let stdout = '';

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        terminatePluginProcess(pluginProcess);
        reject(new Error('Plugin server did not report ready within 10 seconds'));
      }
    }, 10000);

    pluginProcess.stdout.on('data', (data) => {
      if (resolved) return;
      stdout += data.toString();

      // Look for the JSON ready line
      const lines = stdout.split('\n');
      for (const line of lines) {
        try {
          const msg = JSON.parse(line.trim());
          if (msg.ready && typeof msg.port === 'number') {
            clearTimeout(timeout);
            resolved = true;
            if (stoppingAllPlugins) {
              terminatePluginProcess(pluginProcess);
              reject(new Error('Plugin shutdown started before server became ready'));
              return;
            }
            runningPlugins.set(name, { process: pluginProcess, port: msg.port });

            pluginProcess.on('exit', () => {
              runningPlugins.delete(name);
            });

            console.log(`[Plugins] Server started for "${name}" on port ${msg.port}`);
            resolve(msg.port);
          }
        } catch {
          // Not JSON yet, keep buffering
        }
      }
    });

    pluginProcess.stderr.on('data', (data) => {
      console.warn(`[Plugin:${name}] ${data.toString().trim()}`);
    });

    pluginProcess.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to start plugin server: ${err.message}`));
      }
    });

    pluginProcess.on('exit', (code) => {
      clearTimeout(timeout);
      runningPlugins.delete(name);
      if (!resolved) {
        resolved = true;
        reject(new Error(`Plugin server exited with code ${code} before reporting ready`));
      }
    });
  }).finally(() => {
    startingPlugins.delete(name);
    startingPluginProcesses.delete(name);
  });

  startingPlugins.set(name, startPromise);
  return startPromise;
}

/**
 * Stop a plugin's server subprocess.
 * Resolves when the process exits cleanly or the bounded termination sequence
 * has issued its forced kill.
 */
export function stopPluginServer(name) {
  const entry = runningPlugins.get(name);
  if (!entry) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = (success) => {
      if (runningPlugins.get(name) === entry) {
        runningPlugins.delete(name);
      }
      if (success) {
        console.log(`[Plugins] Server stopped for "${name}"`);
        resolve();
      } else {
        reject(new Error(`Failed to stop plugin server "${name}"`));
      }
    };

    terminatePluginProcess(entry.process, cleanup);

    console.log(`[Plugins] Stopping server for "${name}"`);
  });
}

/**
 * Get the port a running plugin server is listening on.
 */
export function getPluginPort(name) {
  return runningPlugins.get(name)?.port ?? null;
}

/**
 * Check if a plugin's server is running.
 */
export function isPluginRunning(name) {
  return runningPlugins.has(name);
}

/**
 * Stop all running plugin servers (called on host shutdown).
 */
export async function stopAllPlugins() {
  stoppingAllPlugins = true;
  const stops = [];
  for (const [name] of runningPlugins) {
    stops.push(stopPluginServer(name));
  }
  for (const pluginProcess of startingPluginProcesses.values()) {
    stops.push(new Promise((resolve, reject) => {
      terminatePluginProcess(pluginProcess, (success) => {
        if (success) resolve();
        else reject(new Error('Failed to stop starting plugin server'));
      });
    }));
  }

  const results = await Promise.allSettled(stops);
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more plugin servers failed to stop');
  }
}

/**
 * Start servers for all enabled plugins that have a server entry.
 * Called once on host server boot.
 */
export async function startEnabledPluginServers() {
  const plugins = scanPlugins();
  const config = getPluginsConfig();

  for (const plugin of plugins) {
    if (!plugin.server) continue;
    if (config[plugin.name]?.enabled === false) continue;

    const pluginDir = getPluginDir(plugin.name);
    if (!pluginDir) continue;

    try {
      await startPluginServer(plugin.name, pluginDir, plugin.server);
    } catch (err) {
      console.error(`[Plugins] Failed to start server for "${plugin.name}":`, err.message);
    }
  }
}
