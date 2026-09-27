#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import fs, { promises as fsPromises, realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { pathToFileURL } from 'url';

import express from 'express';
import cors from 'cors';

import {
    AppError,
    WORKSPACES_ROOT,
    isGitRepositoryRoot,
    validateWorkspacePath,
} from '@/shared/utils.js';
import {
    annotateRepositoryFlags,
    buildBrowseSuggestions,
    parseBrowseCommonDirs,
} from '@/shared/browse-suggestions.js';
import {
    getRouterBasename,
    injectRouterBasenameIntoHtml,
} from '@/shared/router-basename.js';
import { closeSessionsWatcher, initializeSessionsWatcher, startAiSessionTitler, stopAiSessionTitler } from '@/modules/providers/index.js';
import { createWebSocketServer, chatRunRegistry, reconcileInterruptedRuns } from '@/modules/websocket/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';
import {
    queryClaudeSDK,
    abortClaudeSDKSession,
    resolveToolApproval,
    getPendingApprovalsForSession,
    startStaleToolApprovalReaper,
    stopStaleToolApprovalReaper,
} from './modules/providers/list/claude/claude-sdk-runner.js';
import {
    queryCodex,
    abortCodexSession,
} from './modules/providers/list/codex/codex-runner.js';
import {
    spawnAntigravity,
    abortAntigravitySession,
} from './modules/providers/list/antigravity/antigravity-runner.js';
import {
    stripAnsiSequences,
    normalizeDetectedUrl,
    extractUrlsFromText,
    shouldAutoOpenUrlFromOutput,
} from './utils/url-detection.js';
import { runMockAgentProvider } from './routes/mock-agent-provider.js';
import authRoutes from './routes/auth.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import projectFilesRoutes from './routes/project-files.js';
import userRoutes from './routes/user.js';
import usageRoutes from './routes/usage.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { pruneOrphanedBrowserMcp } from './modules/providers/services/orphaned-mcp-cleanup.service.js';
import voiceRoutes from './voice-proxy.js';
import bugReportRoutes from './routes/bug-report.js';
import { assetsRoutes } from './modules/assets/index.js';
import { initializeDatabase, sessionsDb } from './modules/database/index.js';
import { configureWebPush } from './services/vapid-keys.js';
import {
    createCompressionMiddleware,
    mountStaticAssets,
} from './middleware/compression.js';
import { validateApiKey, authenticateToken, authenticateWebSocket } from './middleware/auth.js';
import { IS_PLATFORM, AUTH_DISABLED } from './constants/config.js';
import { resolveInstallMode } from './shared/self-update.js';
import { createHealthRouter, readBuildInfo } from './shared/build-info.js';
import { c } from './utils/colors.js';
import { expandWorkspacePath, listDirectChildDirectories } from './shared/file-tree.js';
import { getLocalServerMarkerPath, removeLocalServerMarker, writeLocalServerMarker } from './shared/local-server-marker.js';

const __dirname = getModuleDir(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findAppRoot(__dirname);
const installMode = resolveInstallMode(fs.existsSync(path.join(APP_ROOT, '.git')));
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
// Per-deploy build identity (#458): the git SHA + build time stamped by
// scripts/dante-build.sh into dist/build-info.json and inlined into the client bundle.
// Captured once at startup like RUNNING_VERSION — the served bundle is fixed for this
// process's lifetime too. Absent on a plain `npm run build` or a pre-#458 tree; /health
// then omits `build` and the frontend falls back to the semver comparison.
const BUILD_INFO = readBuildInfo(APP_ROOT);

console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

const app = express();
const server = http.createServer(app);

// Test-only seam (#102): when AGENT_MOCK_PROVIDER=true, re-point the real chat
// provider runtimes at the deterministic in-process mock (routes/mock-agent-provider.js)
// so a Playwright/e2e browser session can drive a full chat turn — send ->
// streamed frames -> terminal `complete` — with no real CLI/SDK, network, or
// auth. The session's provider column stays provider-native, so the frontend
// flow is unchanged; only the runtime that streams frames is swapped. Read live
// (not import-frozen) so it is a pure env toggle, mirroring the POST /api/agent
// gate in routes/agent.js.
const AGENT_MOCK_PROVIDER = process.env.AGENT_MOCK_PROVIDER === 'true';
const makeMockSpawnFn = (provider) => (message, options, writer) => {
    // Per-turn breadcrumb (mirrors the REST seam's log in routes/agent.js) so a
    // mock-served chat run is individually traceable, not just inferable from
    // the one-time startup warning.
    console.log(`🧪 chat run served by mock provider (AGENT_MOCK_PROVIDER) [provider=${provider}]`);
    return runMockAgentProvider(message, { ...options, provider }, writer);
};
const chatSpawnFns = AGENT_MOCK_PROVIDER
    ? {
        claude: makeMockSpawnFn('claude'),
        codex: makeMockSpawnFn('codex'),
        antigravity: makeMockSpawnFn('antigravity'),
    }
    : {
        claude: queryClaudeSDK,
        codex: queryCodex,
        antigravity: spawnAntigravity,
    };
// Provider abort fns, addressed by the provider-native session id. Shared by the
// chat.abort handler and the stale-run reaper's abort hook (below).
const chatAbortFns = {
    claude: abortClaudeSDKSession,
    codex: abortCodexSession,
    antigravity: abortAntigravitySession,
};
// The activation warning is emitted in the "Ready" banner below (next to the
// AUTH_DISABLED warning), where an operator scanning startup output will see it.

// Single WebSocket server that handles chat and shell paths.
const wss = createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
    },
    chat: {
        spawnFns: chatSpawnFns,
        abortFns: chatAbortFns,
        resolveToolApproval,
        getPendingApprovalsForSession,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
        stripAnsiSequences,
        normalizeDetectedUrl,
        extractUrlsFromText,
        shouldAutoOpenUrlFromOutput,
    },
});

// Make WebSocket server available to routes
app.locals.wss = wss;

app.use(cors({ exposedHeaders: ['X-Refreshed-Token'] }));
// Compress every response that is worth compressing (#266). Mounted ahead of
// the routes so dynamic JSON and index.html are covered; hashed bundles under
// dist/ are served from build-time .br/.gz siblings instead (see the
// precompressed-assets handler below), which this middleware leaves alone.
app.use(createCompressionMiddleware());
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required). Includes the build
// identity (sha + built_at) stamped at build time when present (#458).
app.use(createHealthRouter({
    installMode,
    version: RUNNING_VERSION,
    build: BUILD_INFO,
}));

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat image asset upload/serving (global ~/.cloudcli/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Local feature-usage counters (protected, issue #248)
app.use('/api/usage', authenticateToken, usageRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

app.use('/api/voice', authenticateToken, voiceRoutes);

// In-app bug reporter — durably queues GitHub issues through the host-local worker (protected)
app.use('/api/bug-report', authenticateToken, bugReportRoutes);

// Project file CRUD + upload endpoints (server/routes/project-files.js); each
// route applies its own authenticateToken, matching the mounts above.
app.use(projectFilesRoutes);

// Serve the SPA's index.html through a small response transform so we can
// inject `window.__ROUTER_BASENAME__` before any client JS executes. This is
// what lets the SPA work when mounted behind a reverse-proxy path prefix
// (e.g. https://example.com/cloudcli/) without the brittle nginx
// sub_filter hack we used to rely on.
//
// The transform always runs, including when ROUTER_BASENAME is unset — in
// that case we inject `""` so the historical `|| ""` fallback in App.tsx is
// preserved exactly. This must NOT break the default
// `npm install -g @cloudcli-ai/cloudcli && cloudcli` flow.
const DIST_INDEX_PATH = path.join(APP_ROOT, 'dist', 'index.html');

function sendIndexHtmlWithBasename(req, res) {
    if (!fs.existsSync(DIST_INDEX_PATH)) {
        return false;
    }
    const html = fs.readFileSync(DIST_INDEX_PATH, 'utf8');
    const basename = getRouterBasename(process.env);
    const transformed = injectRouterBasenameIntoHtml(html, basename);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(transformed);
    return true;
}

// Intercept the two SPA entry paths that the static handlers would otherwise
// serve directly from disk (`/` via directory-index behaviour, and
// `/index.html` explicitly), so the basename transform above is the only thing
// that answers them. Mounted ahead of the static stack for that reason; every
// other asset flows through express.static below unchanged. Neither static root
// contains an index.html of its own, so nothing else changes hands here.
app.get(['/', '/index.html'], (req, res, next) => {
    if (!sendIndexHtmlWithBasename(req, res)) {
        return next();
    }
});

// Static files served after API routes. mountStaticAssets owns the ordering of
// all three static handlers — public/ first (it decides the cache policy for
// the files vite copies into both trees, notably sw.js and the fonts), then the
// rewriter that points a request at its build-time compressed sibling
// (`<asset>.br` / `<asset>.gz`) and, directly after it, the express.static that
// sends it. Keeping them in one function is what makes the shipped order the
// tested order.
const DIST_DIR = path.join(APP_ROOT, 'dist');
mountStaticAssets(app, {
    publicDir: path.join(APP_ROOT, 'public'),
    distDir: DIST_DIR,
});

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// Common-dir names promoted to the front of the folder picker when browsing the
// workspace root. Read once at startup from BROWSE_COMMON_DIRS. Default (unset)
// keeps the historical hardcoded list for backward compatibility; set the var
// to a comma-separated list to customize, or to an empty string to disable the
// reordering entirely (useful when WORKSPACES_ROOT is a narrow root like ~/repos
// where those names never appear — see issue #227). See server/shared/browse-suggestions.ts.
const BROWSE_COMMON_DIRS = parseBrowseCommonDirs(process.env.BROWSE_COMMON_DIRS);

// Browse filesystem endpoint for the project-creation folder picker. Returns
// only immediate child directories of the requested path — no recursion, no
// per-entry stat — which keeps the folder picker responsive even when the home
// directory contains huge subtrees like ~/.claude/projects/.
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath, repoFlags } = req.query;
        // Opt-in: the folder picker needs to know which children are git
        // repositories so it can list repos only (#309). Path autocomplete
        // doesn't, and this costs a stat per entry — so it stays off by
        // default rather than being folded into the listing.
        const includeRepoFlags = repoFlags === '1' || repoFlags === 'true';

        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath, WORKSPACES_ROOT) : defaultRoot;

        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Security check - ensure path is within allowed workspace root
        const validation = await validateWorkspacePath(targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolvedPath = validation.resolvedPath || targetPath;

        // Security check - ensure path is accessible
        try {
            await fs.promises.access(resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);

            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }

        // List only the immediate child directories. The folder picker doesn't
        // render anything below this level, so there's no reason to recurse —
        // see listDirectChildDirectories for the perf rationale.
        const directories = (await listDirectChildDirectories(resolvedPath))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });

        // When browsing the workspace root, optionally promote the configured
        // common-dir names to the front (see BROWSE_COMMON_DIRS above). The
        // ordering logic lives in the pure, unit-tested buildBrowseSuggestions.
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        const isAtRoot = resolvedPath === resolvedWorkspaceRoot;
        const orderedDirectories = buildBrowseSuggestions(
            directories,
            BROWSE_COMMON_DIRS,
            isAtRoot,
        );
        const suggestions = includeRepoFlags
            ? await annotateRepositoryFlags(orderedDirectories, isGitRepositoryRoot)
            : orderedDirectories;

        // `isAtRoot` is what lets the picker hide its ".." row here: only the
        // server knows WORKSPACES_ROOT, so a client deriving the parent by
        // string manipulation would offer a click that can only 403 (#238).
        res.json({
            path: resolvedPath,
            suggestions: suggestions,
            isAtRoot
        });

    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

app.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        const expandedPath = expandWorkspacePath(folderPath, WORKSPACES_ROOT);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const targetPath = validation.resolvedPath || resolvedInput;
        const parentDir = path.dirname(targetPath);
        try {
            await fs.promises.access(parentDir);
        } catch (err) {
            return res.status(404).json({ error: 'Parent directory does not exist' });
        }
        try {
            await fs.promises.access(targetPath);
            return res.status(409).json({ error: 'Folder already exists' });
        } catch (err) {
            // Folder doesn't exist, which is what we want
        }
        try {
            await fs.promises.mkdir(targetPath, { recursive: false });
            res.json({ success: true, path: targetPath });
        } catch (mkdirError) {
            if (mkdirError.code === 'EEXIST') {
                return res.status(409).json({ error: 'Folder already exists' });
            }
            throw mkdirError;
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Chat image uploads moved to POST /api/assets/images (server/modules/assets),
// which stores them in the global ~/.cloudcli/assets folder.

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above.
    // We route through sendIndexHtmlWithBasename so the ROUTER_BASENAME injection
    // is applied here too (deep-link refreshes hit this branch, not the `/`
    // handler above).
    if (sendIndexHtmlWithBasename(req, res)) {
        return;
    }

    // In development, redirect to Vite dev server only if dist doesn't exist
    const redirectHost = getConnectableHost(req.hostname);
    res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
});
// global error middleware must be last
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

const SERVER_PORT = process.env.SERVER_PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = getLocalServerMarkerPath(os.homedir());

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // Surface any chat runs stranded by a previous restart as interrupted +
        // resumable, before the server accepts websocket traffic, so no in-flight
        // or queued message is silently lost (#70).
        try {
            reconcileInterruptedRuns();
        } catch (err) {
            console.error('[ChatRunReconcile] Failed to reconcile interrupted runs:', err?.message || err);
        }

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${c.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);            
        }

        console.log(`${c.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);
   
        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker(LOCAL_SERVER_MARKER_PATH, {
                pid: process.pid,
                host: HOST,
                port: Number.parseInt(String(SERVER_PORT), 10),
                url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
                installMode,
                appRoot: APP_ROOT,
            }).catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(c.dim('═'.repeat(63)));
            console.log(`  ${c.bright('CloudCLI Server - Ready')}`);
            console.log(c.dim('═'.repeat(63)));
            console.log('');
            console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
            console.log(`${c.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            if (AUTH_DISABLED) {
                console.warn('[WARN] VITE_AUTH_DISABLED is set — login is OFF; every request runs as the single default user.');
            }
            if (AGENT_MOCK_PROVIDER) {
                console.warn('[WARN] AGENT_MOCK_PROVIDER is set — chat runs use the deterministic in-process mock provider, NOT a real CLI/SDK.');
            }
            console.log('');

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();

            // Start the AI session-title worker (opt-in; no-op unless enabled)
            startAiSessionTitler();

            // One-time cleanup of the orphaned 'cloudcli-browser' MCP registration
            // left in provider configs by the removed browser-use feature (#95).
            pruneOrphanedBrowserMcp().catch(err => {
                console.error('[MCP cleanup] Error pruning orphaned browser MCP:', err?.message || err);
            });

            // Reap runs abandoned mid-approval (idle child processes) (#86).
            startStaleToolApprovalReaper();

            // Reap runs whose provider generator wedged without ever emitting a
            // terminal `complete` — otherwise a finished session shows "running"
            // forever. The hook interrupts the wedged child (best-effort) before
            // the reaper force-completes the run in the registry.
            chatRunRegistry.setRunAbortHook((run) => {
                const abortFn = chatAbortFns[run.provider];
                if (abortFn && run.providerSessionId) {
                    return abortFn(run.providerSessionId);
                }
                return undefined;
            });
            chatRunRegistry.startStaleRunReaper();
        });

        // Graceful-drain window: on SIGTERM/SIGINT, stop accepting new chat runs
        // and give in-flight runs a bounded chance to finish before the process
        // exits, shrinking the window where a deploy/reconcile guillotines a turn
        // mid-stream. Runs that finish clear their durable journal record; any
        // still live at the deadline are killed with the process but survive as
        // interrupted+resumable via the startup reconcile (#70).
        const parsedDrainTimeout = Number.parseInt(process.env.CHAT_DRAIN_TIMEOUT_MS || '', 10);
        const CHAT_DRAIN_TIMEOUT_MS = Number.isFinite(parsedDrainTimeout) && parsedDrainTimeout >= 0
            ? parsedDrainTimeout
            : 10000;

        // Guard against a second signal (or SIGTERM then SIGINT) re-entering the
        // shutdown sequence while the drain is still in progress.
        let shuttingDown = false;

        const shutdownRuntimeServices = async () => {
            if (shuttingDown) {
                return;
            }
            shuttingDown = true;

            try {
                console.log('[Shutdown] Signal received; draining active chat runs before exit', {
                    timeoutMs: CHAT_DRAIN_TIMEOUT_MS,
                });
                chatRunRegistry.beginDrain();
                const drainResult = await chatRunRegistry.waitForActiveRuns(CHAT_DRAIN_TIMEOUT_MS);
                if (drainResult.drained && drainResult.interrupted > 0) {
                    // A run's provider child died with the server's own signal (e.g.
                    // systemd KillMode=control-group, or Ctrl-C in a terminal) — #535.
                    console.warn('[Shutdown] Chat runs were killed mid-drain; they will resume after restart', {
                        interrupted: drainResult.interrupted,
                    });
                } else if (drainResult.drained) {
                    console.log('[Shutdown] All chat runs drained cleanly before exit');
                } else {
                    console.warn('[Shutdown] Drain timed out with runs still active; they will resume after restart', {
                        remaining: drainResult.remaining,
                        interrupted: drainResult.interrupted,
                        timeoutMs: CHAT_DRAIN_TIMEOUT_MS,
                    });
                }
            } catch (err) {
                console.error('[Shutdown] Error draining chat runs:', err?.message || err);
            }

            try {
                stopStaleToolApprovalReaper();
            } catch (err) {
                console.error('[approval reaper] Error stopping reaper during shutdown:', err?.message || err);
            }
            try {
                chatRunRegistry.stopStaleRunReaper();
            } catch (err) {
                console.error('[run reaper] Error stopping reaper during shutdown:', err?.message || err);
            }
            try {
                stopAiSessionTitler();
            } catch (err) {
                console.error('[AI titles] Error stopping titler during shutdown:', err?.message || err);
            }
            try {
                await closeSessionsWatcher();
            } catch (err) {
                console.error('[Sessions watcher] Error stopping watcher during shutdown:', err?.message || err);
            }
            try {
                await removeLocalServerMarker(LOCAL_SERVER_MARKER_PATH, process.pid);
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', err?.message || err);
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

// Only auto-start the HTTP server (and its DB init / timers / listeners) when
// this file is run directly (`node server/index.js`, `tsx server/index.js`, the
// packaged `cloudcli` bin, etc.). Importing it — e.g. from a test that wants
// `app`/`server`/`wss` without a live port or a real database — must be a pure
// module load. Compares REALPATHS so a symlinked entry point (npm global
// installs, `tsx` shims) still matches; falls back to "not main" on any
// resolution error rather than accidentally auto-starting.
function isMainModule() {
    try {
        const invokedPath = process.argv[1];
        if (!invokedPath) {
            return false;
        }
        return pathToFileURL(realpathSync(invokedPath)).href === import.meta.url;
    } catch {
        return false;
    }
}

if (isMainModule()) {
    startServer();
}

export { app, server, wss, startServer };
