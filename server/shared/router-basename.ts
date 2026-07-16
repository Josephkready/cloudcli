// Helpers for injecting `window.__ROUTER_BASENAME__` into the SPA's index.html
// before it is sent to the browser.
//
// Why this exists:
//   When the SPA is hosted behind a reverse-proxy path prefix (e.g.
//   `https://example.com/cloudcli/`), React Router needs `basename` set
//   to that prefix or the app unmounts after client-side navigation because
//   the URL ("/cloudcli/...") no longer matches the router's mount point
//   ("/"). The frontend reads `window.__ROUTER_BASENAME__ || ""`, so the
//   server is responsible for setting that global before the SPA JS runs.
//
// Design:
//   - Pure string functions so they are trivial to unit test with `node:test`.
//   - The injection point is "immediately after the literal `<head>` tag"
//     so the variable is defined before any `<script>` later in the document
//     (including the bundled SPA script in `<body>`).
//   - When `ROUTER_BASENAME` is unset we still inject `""` so the production
//     `||  ""` fallback path remains exercised by tests and stays the
//     behavioural default for the `npm install -g @cloudcli-ai/cloudcli`
//     flow.

const HEAD_OPEN_PATTERN = /<head(\s[^>]*)?>/i;

export type RouterBasenameInjectionEnv = {
  ROUTER_BASENAME?: string;
};

/**
 * Read the router basename from a process-env-shaped object.
 *
 * Returns an empty string (the historical default) when the variable is
 * unset, undefined, or the empty string.
 */
export function getRouterBasename(env: RouterBasenameInjectionEnv): string {
  const value = env.ROUTER_BASENAME;
  if (value == null) {
    return '';
  }
  return value;
}

/**
 * Build the `<script>` tag that assigns `window.__ROUTER_BASENAME__`.
 *
 * The basename value is JSON-encoded so any embedded quotes, backslashes, or
 * `</script>` sequences are safely escaped before being emitted into the HTML.
 */
export function buildRouterBasenameScript(basename: string): string {
  const safeValue = JSON.stringify(basename).replace(/</g, '\\u003c');
  return `<script>window.__ROUTER_BASENAME__=${safeValue};</script>`;
}

/**
 * Inject the router-basename script immediately after the opening `<head>` tag.
 *
 * If the HTML does not contain a `<head>` tag (e.g. the request was for some
 * non-SPA HTML payload) the original string is returned unchanged. This keeps
 * the transform safe to apply broadly without corrupting unrelated responses.
 */
export function injectRouterBasenameIntoHtml(
  html: string,
  basename: string,
): string {
  const match = HEAD_OPEN_PATTERN.exec(html);
  if (!match) {
    return html;
  }
  const insertAt = match.index + match[0].length;
  const script = buildRouterBasenameScript(basename);
  return html.slice(0, insertAt) + script + html.slice(insertAt);
}
