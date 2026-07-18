# Plugins (drop-install)

CloudCLI plugins render a **custom web-UI tab** inside the app. They give no
tools/MCP/hooks to agents — that's the separate MCP path (`claude-mcp` /
`codex-mcp`). A plugin is just a folder with a `manifest.json`, a browser entry
module, and (optionally) a small Node server.

There is **no install/marketplace UI** — you (or an agent) install a plugin by
writing files. The loader filesystem-scans the plugins directory on boot and
enables plugins by default.

## Install a plugin

Drop a folder into the plugins directory:

```
~/.claude-code-ui/plugins/<name>/
  manifest.json      # required
  index.js           # the browser entry module (name it whatever `entry` points at)
  server.js          # optional Node subprocess (see `server` below)
```

Restart the host (or reload) — the new tab appears. Plugins are **enabled by
default**; to disable one without deleting it, set
`~/.claude-code-ui/plugins.json` → `{ "<name>": { "enabled": false } }`.

## manifest.json

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "entry": "index.js",
  "icon": "Puzzle",
  "type": "module",
  "slot": "tab",
  "server": null,
  "permissions": []
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | ✅ | Unique id, `[a-zA-Z0-9_-]+`. Duplicate names are skipped. |
| `displayName` | ✅ | Shown on the tab. |
| `entry` | ✅ | Relative path to the browser module (no `..`, not absolute). |
| `icon` | | Lucide icon name (default `Puzzle`). |
| `type` | | `module` (default) or `react`. |
| `slot` | | `tab` (only supported slot; default). |
| `server` | | Relative path to a Node subprocess, or `null`/omit for UI-only. |
| `permissions` | | Array of strings (informational). |
| `version`, `description`, `author` | | Optional metadata. |

An invalid manifest is skipped with a `[Plugins]` warning on the server log.

## Browser entry module

The `entry` module is imported in the browser and must export `mount`:

```js
export function mount(container, api) {
  // build your UI into `container` (an HTMLElement)
  container.textContent = 'Hello from my-plugin';

  // react to theme / project / session changes
  const off = api.onContextChange((ctx) => {
    // ctx = { isDarkMode, selectedProject, selectedSession }
  });

  // talk to your optional server subprocess (see below)
  api.rpc('GET', '/status').then((data) => { /* ... */ });

  // stash cleanup for unmount if you need it
  container._off = off;
}

export function unmount(container) {  // optional
  container._off?.();
}
```

`api` provides:

- `api.context` — current `{ isDarkMode, selectedProject, selectedSession }`.
- `api.onContextChange(cb)` — subscribe to context changes; returns an unsubscribe fn.
- `api.rpc(method, path, body?)` — call your plugin's server subprocess, proxied
  through `/api/plugins/<name>/rpc/*`. Rejects on non-2xx, resolves the JSON body.

## Optional server subprocess

If `manifest.server` points at a Node file, the host starts it as a subprocess
for enabled plugins and proxies `api.rpc(...)` calls to it over
`/api/plugins/<name>/rpc/*`. Leave `server` `null` for a pure-UI plugin.
