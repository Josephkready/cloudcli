<div align="center">
 <img src="public/logo.svg" alt="Cloud CLI" width="64" height="64">
 <h1>Cloud CLI</h1>
 <p>A single-user web UI + iOS PWA for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://developers.openai.com/codex">Codex</a>, and <a href="https://antigravity.google/cli">Google Antigravity CLI</a> — view and drive your agent sessions from any device on the tailnet.</p>
</div>

---

## About this fork

This is a **private, single-user fork** of [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui), trimmed and adapted for one specific deployment:

- **Single user, LAN/tailnet-only** web app + iOS PWA — not exposed to the public internet.
- Runs as a **host `systemd` service** (bare metal, no Docker) on the `dante` host.
- **Login is disabled** (single-user install); the auth stack is kept buildable as a security fallback, not deleted.
- **Claude + Codex + Antigravity providers only** — upstream's other providers, the desktop/Electron app, Docker sandboxing, browser-use, and the marketing/community surface are being removed to lean out the fork (see the `cleanup` / `epic` issues).
- **Deployed by `ansible-pull`** from a git checkout: merges to `origin/main` are reconciled onto the host automatically — there is no npm publish and no release cut.

When the retained login fallback is enabled, failed logins receive escalating
per-username backoff and a 15-minute lockout after five failures. The server
also admits at most ten login checks per minute from one direct network peer,
before bcrypt runs. Blocked requests return HTTP `429` with `Retry-After`;
limiter state is process-local and resets when the server restarts. Reverse
proxy deployments therefore share the proxy peer's conservative IP budget.
Fallback-auth logout also revokes every outstanding JWT for that user, across
REST and WebSocket connections, while leaving other users and the installation
signing secret untouched. The database migration intentionally invalidates JWTs
issued by an older CloudCLI version once, because those tokens have no revocable
version claim.

Because of that shape, this fork **intentionally diverges** from upstream. Feature removals are kept as atomic, well-labeled commits so future upstream syncs resolve to a simple "re-delete."

## Sibling forks

Upstream merges slowly — 20 commits in the six weeks after our fork point,
against ~80 open PRs — so it is not a useful source of fixes. A handful of *other*
forks are, though: people running this app on a phone every day, hitting the same
mobile, PWA, and chat bugs, and fixing them.

Finding them takes a specific search — upstream has thousands of forks and almost
all are untouched mirrors, so sorting by stars surfaces none of the live ones.
The discovery commands, the current roster, the acceptance filter for a
single-user fork, and the process for deciding what is worth porting all live in
[`docs/fork-harvesting.md`](docs/fork-harvesting.md).

## Development

Requires Node.js v22+.

```bash
npm ci             # install dependencies
npm run dev        # server + client with hot reload
npm run build      # production build (vite + asset precompression + tsc)
npm run typecheck  # tsc --noEmit (client + server)
npm test           # server, front-end unit, and component test suites
npm run lint       # eslint src/ server/
```

The server serves the built client and the API on port `3001` by default. See `.env.example` for configuration (ports, database path, `ROUTER_BASENAME` for subpath hosting, `CLOUDCLI_AI_TITLES_*` for optional AI-shortened session titles, `CLOUDCLI_EXCLUDED_PROJECT_PATHS` for sidebar filtering, and more).

Plugins (custom web-UI tabs, drop-installed by writing files): see [`docs/plugins.md`](docs/plugins.md).

### Streaming API authentication

Browser SSE calls use `Authorization: Bearer <token>`; bearer tokens are not
accepted in URL query parameters. Conversation search remains
`GET /api/providers/search/sessions?q=...`, while repository clone progress uses
`POST /api/projects/clone-progress` with a JSON body containing `path`,
`githubUrl`, and, when credentials are needed, optional `githubTokenId` or
`newGithubToken`. Clients using the former GET/query-string clone contract must
migrate to the POST body contract.

## Local feature-usage counters

Alongside the auth/session data in `~/.cloudcli/auth.db` (`DATABASE_PATH`), the
app keeps a `feature_usage` table: one aggregate row per feature — a count plus
the first/last time it was touched. It exists so the next round of leaning out
the fork can be driven by evidence about what actually gets used rather than by
guesswork (issue #248).

It is **aggregate counters, not an event log**: no per-event rows, no arguments,
no content, no third-party analytics, and nothing ever leaves the machine. The
key list in [`shared/featureKeys.ts`](shared/featureKeys.ts) is a closed literal
union, so it doubles as the feature inventory and a removed feature's key fails
typecheck.

```bash
node dist-server/server/cli.js usage           # every key, least-used first
node dist-server/server/cli.js usage --json    # machine-readable
node dist-server/server/cli.js usage --clear   # reset the counters
npm run usage                                  # same readout, from a dev checkout
```

Set `FEATURE_USAGE_ENABLED=false` in `.env` to stop recording.

Reading the output takes judgement: zero usage is a *candidate* for removal, not
a verdict. Give it a long window (90+ days — rare is not dead), and rule out
"unused because it's broken or undiscoverable" before trusting a zero.

## Reporting bugs

The bug icon in the app's top panel opens a reporter: write what went wrong, and
the app attaches the session details (versions, provider, space, active tab,
browser) and files a GitHub issue for you. It shows you exactly what it will
send before it sends it.

Filing runs the **host's `gh` CLI**, so the server needs `gh` installed and
authenticated (`gh auth login`) — otherwise the dialog reports the failure and
files nothing. Reports go to `Josephkready/cloudcli` unless `BUG_REPORT_REPO`
says otherwise.

## Deployment

Production runs on `dante` and is reconciled by `ansible-pull` against `origin/main`. The build (`scripts/dante-build.sh`: `npm ci` + `vite build` + asset precompression + `tsc`/`tsc-alias`, atomic swap) and the `systemd` unit that runs `node dist-server/server/index.js` are owned by the deploy repo — **ship changes by merging to `origin/main`, not by SSH+rsync.** See the mind design doc `cloudcli-dante-deploy` and the `dante-sync` / `dante-live` skills for the full workflow.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE) for the full text, including additional terms under Section 7, and [NOTICE](NOTICE) for attribution.

If you modify this software and run it as a network service, you must make your modified source available to users of that service.

## Acknowledgments

Forked from **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** (AGPL-3.0). Built with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex), [React](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/), and [CodeMirror](https://codemirror.net/).
