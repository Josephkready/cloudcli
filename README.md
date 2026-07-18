<div align="center">
 <img src="public/logo.svg" alt="Cloud CLI" width="64" height="64">
 <h1>Cloud CLI</h1>
 <p>A single-user web UI + iOS PWA for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> and <a href="https://developers.openai.com/codex">Codex</a> — view and drive your agent sessions from any device on the tailnet.</p>
</div>

---

## About this fork

This is a **private, single-user fork** of [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui), trimmed and adapted for one specific deployment:

- **Single user, LAN/tailnet-only** web app + iOS PWA — not exposed to the public internet.
- Runs as a **host `systemd` service** (bare metal, no Docker) on the `dante` host.
- **Login is disabled** (single-user install); the auth stack is kept buildable as a security fallback, not deleted.
- **Claude + Codex providers only** — upstream's other providers, the desktop/Electron app, Docker sandboxing, TaskMaster, browser-use, and the marketing/community surface are being removed to lean out the fork (see the `cleanup` / `epic` issues).
- **Deployed by `ansible-pull`** from a git checkout: merges to `origin/main` are reconciled onto the host automatically — there is no npm publish and no release cut.

Because of that shape, this fork **intentionally diverges** from upstream. Feature removals are kept as atomic, well-labeled commits so future upstream syncs resolve to a simple "re-delete."

## Development

Requires Node.js v22+.

```bash
npm ci             # install dependencies
npm run dev        # server + client with hot reload
npm run build      # production build (vite + tsc)
npm run typecheck  # tsc --noEmit (client + server)
npm test           # server + unit test suites
npm run lint       # eslint src/ server/
```

The server serves the built client and the API on port `3001` by default. See `.env.example` for configuration (ports, database path, `ROUTER_BASENAME` for subpath hosting, `CLOUDCLI_AI_TITLES_*` for optional Ollama-backed session titles, `CLOUDCLI_EXCLUDED_PROJECT_PATHS` for sidebar filtering, and more).

## Deployment

Production runs on `dante` and is reconciled by `ansible-pull` against `origin/main`. The build (`scripts/dante-build.sh`: `npm ci` + `vite build` + `tsc`/`tsc-alias`, atomic swap) and the `systemd` unit that runs `node dist-server/server/index.js` are owned by the deploy repo — **ship changes by merging to `origin/main`, not by SSH+rsync.** See the mind design doc `cloudcli-dante-deploy` and the `dante-sync` / `dante-live` skills for the full workflow.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE) for the full text, including additional terms under Section 7, and [NOTICE](NOTICE) for attribution.

If you modify this software and run it as a network service, you must make your modified source available to users of that service.

## Acknowledgments

Forked from **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** (AGPL-3.0). Built with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex), [React](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/), and [CodeMirror](https://codemirror.net/).
