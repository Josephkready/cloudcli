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
npm run lint       # eslint src/ server/ e2e/ bench/
npm run bench      # end-to-end performance benchmark (see bench/README.md)
```

The server serves the built client and the API on port `3001` by default. See `.env.example` for configuration (ports, database path, `ROUTER_BASENAME` for subpath hosting, `CLOUDCLI_AI_TITLES_*` for optional AI-shortened session titles, `CLOUDCLI_EXCLUDED_PROJECT_PATHS` for sidebar filtering, and more).

Performance benchmark (measures the core chat journeys end to end, against a seeded fixture library): see [`bench/README.md`](bench/README.md).

### Streaming API authentication

Browser SSE calls use `Authorization: Bearer <token>`; bearer tokens are not
accepted in URL query parameters. Conversation search remains
`GET /api/providers/search/sessions?q=...`.

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

## Visual QA (video-debugger)

`vdebug/` records the app's core journeys as video + checkpoint frames across a
matrix of real screens (iPhone 13 Pro, iPad Pro 11", 2K, 4K, and half-2K / third-4K
windows; `mobile`/`tablet`/`desktop`/`ultrawide` still work as aliases), runs DOM
layout checks at every checkpoint, and (with `--judge`) has a vision model on OpenRouter review the
deduped video frames, animations included. Run it against the throwaway fixture
server — synthetic transcripts, mock chat provider, never your real sessions:

```bash
npx tsx --tsconfig bench/tsconfig.json vdebug/serve-fixture.ts   # prints VDEBUG_BASE_URL=...
python3 vdebug/vdebug.py list
python3 vdebug/vdebug.py record --base-url $VDEBUG_BASE_URL --viewports all --judge
```

Pass `--viewports iphone-13-pro,2k` (or `all,kiosk=2560x1600`) to narrow or extend the
matrix, and `--reset-cmd CMD` to restore app state before every recording. The judge is
also sent `vdebug/judge_notes.md`, the app's intentional designs (the jump-to-bottom
button, horizontally scrolling code blocks, the 44px `::after` touch overlays, …) — add
to it when the judge flags something that is by design. On `iphone-13-pro` and
`ipad-pro-11`, focusing a text field opens a simulated on-screen keyboard (the
visual viewport shrinks, as on iOS), and the `keyboard-covers-*` checks report what it
hides. Because `index.html` disables pinch-zoom on purpose, every touch mark carries one
accepted `zoom-disabled` hit in place of per-input `ios-input-zoom` hits (see
`judge_notes.md`). Every text field the fixture can reach has a flow that types into it and
marks while the keyboard is up: sidebar search (`home-sidebar`, `search-chats`), the composer
and its `/` and `@` menus (`composer-keyboard`, `new-chat-turn`, `composer-commands`), the
folder and model pickers (`new-chat-turn`, `model-picker`), inline renames (`rename-project`,
`rename-session`), the bug reporter (`bug-report`) and Settings (`settings-api-tokens`,
`settings-permissions`, `settings-voice`). Not covered, because the fixture never shows them:
login/setup (auth is off), onboarding's git fields (onboarding is pre-completed), the
provider-login terminal, and AskUserQuestion's free-text answer. A flow can opt out of the
keyboard with `KEYBOARD = False`. Read `vdebug-runs/latest/report.md` (gitignored). `--judge` needs
`OPENROUTER_API_KEY` and `ffmpeg`; Python needs `playwright`. Flows live in
`vdebug/flows/` (role/label/testid locators only). **After changing front-end
code, re-record the flows that touch those screens before opening a PR.** Full
method: the `video-debugger` skill.

**On a real iOS Simulator (`--viewports ios-sim`).** Chromium's `iphone-13-pro` preset cannot
enter iOS standalone mode, which is where the home-screen app's keyboard and layout bugs live
(#354 reproduced only from the icon). The opt-in `ios-sim` viewport drives a real iPhone 13 Pro
Simulator on perfbook through `ios_hub` (the `ios-automation` skill): it installs the app to the
home screen, launches it standalone, and runs each flow's `run_ios(device, vd)` with native
taps, so the real keyboard opens. `composer-keyboard`, `new-chat-turn` and `open-conversation`
have one; other flows are skipped for `ios-sim`. The Simulator is another machine, so serve
the fixture with a reverse tunnel to it:

```bash
npm run ios:debug          # fixture on 127.0.0.1:4870, tunnelled to perfbook's own loopback
python3 vdebug/vdebug.py record --base-url http://localhost:4870 --viewports ios-sim \
  --flow composer-keyboard,new-chat-turn,open-conversation
```

`ios_hub` is not a cloudcli dependency: install it once with `pip install -e ~/repos/ios-hub`.
Once the tunnel is verified from perfbook, `ios:debug` prints
`VDEBUG_IOS_BASE_URL=http://localhost:4870` (the `--base-url` to pass). Ctrl-C or SIGTERM, at
any point including mid-startup, stops the server, closes the tunnel and deletes the fixture HOME.
`npm run ios:debug -- --port N --ios-tunnel <host> --profile standard --skip-build` adjusts it.
`localhost` is right here only because of the tunnel (perfbook's loopback forwards to dante);
the debug instance has no auth, so it never listens on a LAN address. Loopback base URLs install
under a per-port home-screen name (`vdebug-4870`), so two instances never share an icon. Budget
~2 min per flow (lease, install, launch), and always let the run finish or the lease release.
`run_ios` steps use `IosApp` in `vdebug/flows/_helpers.py`, which turns DOM rects into screen
points and records a `keyboard-covers-control` hit when the keyboard hides the composer. The
DOM-to-screen y offset depends on the iOS version and the shell CSS (0 on iOS 26.5, 47pt on iOS 27,
though `screen.height - innerHeight` is 47 on both), so it is calibrated per page against the
native accessibility tree (`device.source()`), checked after each tap and recalibrated once on a
miss. `screen.height - innerHeight` is only a logged fallback when no anchor element matches. The Simulator runs a newer
iOS on a fast Mac: it catches layout and behaviour, not real-phone timings or touch latency.

**Real-user flow capture.** `public/vd-recorder.js` sends intent events to
`POST /api/_vd/events`, stored in `flows.db` beside `DATABASE_PATH`
(`/var/lib/cloudcli/flows.db` on dante; override with `VD_FLOWS_DB`). No input
values, no tab titles, and no names from `data-vd-mask` regions (transcript,
composer, conversation/project lists, search results, session tabs, editor);
automation (`navigator.webdriver`) is never recorded. Retention is 30 days
(`VD_CAPTURE_RETENTION_DAYS`), pruned in-process. `VD_CAPTURE_ENABLED=false`
turns it off. The script tag's `data-sample` (in `index.html`, default `1.0`) is the
fraction of browser sessions recorded; `0` records none. Mine it once real traffic accumulates:

```bash
python3 vdebug/capture/flowstore.py stats --db /var/lib/cloudcli/flows.db
python3 vdebug/capture/flowstore.py mine  --db /var/lib/cloudcli/flows.db --min-sessions 3 --out /tmp/mined.json
```

## Reporting bugs

The bug icon in the app's top panel opens a reporter: write what went wrong, and
the app attaches the session details (versions, provider, space, active tab,
browser) and durably queues a GitHub issue for you. It shows you exactly what it
will send before it sends it. You can also attach up to 3 screenshots — a file
picker (with the camera offered on a phone) or pasting an image (Ctrl/Cmd-V) on
desktop — each compressed client-side (1600px long edge, WebP/JPEG) to roughly
2MB or less before it ever reaches the network, with a thumbnail preview and a
remove control. The server re-validates count, size, and the actual file
content independently of the client before queueing.

The POST returns as soon as the host-local `issue-queue` SQLite database owns
the report (and, for a report with screenshots, has durably copied their bytes
into its own storage). The dialog then polls a content-free authenticated
status endpoint for the final issue link; a separate worker owns GitHub
authentication, rate limits, retries, ambiguous-create reconciliation, and
uploading any screenshots to the shared assets repo referenced in the filed
issue. The server and worker must share `ISSUE_QUEUE_DB`. Reports go to
`Josephkready/cloudcli` unless `BUG_REPORT_REPO` says otherwise.

## Deployment

Production runs on `dante` and is reconciled by `ansible-pull` against `origin/main`. The build (`scripts/dante-build.sh`: `npm ci` + `vite build` + asset precompression + `tsc`/`tsc-alias`, atomic swap) and the `systemd` unit that runs `node dist-server/server/index.js` are owned by the deploy repo — **ship changes by merging to `origin/main`, not by SSH+rsync.** See the mind design doc `cloudcli-dante-deploy` and the `dante-sync` / `dante-live` skills for the full workflow.

### Build identity and the stale-tab reload

Because deploys ship by `ansible-pull` with no version bumps, `package.json`'s semver is identical across deploys and an open tab can never tell a new build landed from the version string alone. Every dante build therefore stamps a **build identity** — the git SHA it was built from plus a UTC build timestamp — and embeds it twice from the same source:

- `scripts/dante-build.sh` exports `VITE_BUILD_SHA` / `VITE_BUILT_AT` (falling back to `unknown` + build time when git is unavailable), which `vite.config.js` inlines into the client bundle via Vite `define`, and
- the same values are written to `dist/build-info.json`, which the server reads at startup and reports from `/health` under `build: {sha, built_at}`.

`useVersionCheck` polls `/health` (every minute, and on tab resume) and compares the bundle's embedded SHA against the server's. A mismatch means the tab is running old JavaScript against a patched server, and the app shows a small non-blocking "New version available — Reload" banner (`NewVersionBanner`). It never reloads mid-conversation: auto-reload only fires when the tab returns from hidden to visible **and** the app is idle (no in-flight stream, no unsent composer text) — which is when a phone PWA typically comes back. When build identity is absent on either side (plain `npm run dev`/`npm run build`, or a pre-change server), the historical semver comparison remains as a fallback. The manual reload button is always available regardless of idleness.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE) for the full text, including additional terms under Section 7, and [NOTICE](NOTICE) for attribution.

If you modify this software and run it as a network service, you must make your modified source available to users of that service.

## Acknowledgments

Forked from **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** (AGPL-3.0). Built with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex), [React](https://react.dev/), [Vite](https://vitejs.dev/), and [Tailwind CSS](https://tailwindcss.com/).
