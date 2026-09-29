/**
 * The demand-loaded surfaces that are worth warming ahead of the click.
 *
 * Declared once and shared by the `lazySurface(...)` boundary and the idle
 * warm-up so the two can never drift apart: a warm-up pointing at a module the
 * boundary no longer uses would fetch a chunk nobody needs and still leave the
 * click cold, and nothing would notice.
 */

export type SurfaceLoader = () => Promise<unknown>;

export const loadStandaloneShell = () => import('../standalone-shell/view/StandaloneShell');
export const loadEditorSidebar = () => import('../code-editor/view/EditorSidebar');

/**
 * Bug reporting (~22 KB with its attachment/compression helpers) is reachable
 * from every session but used far less often than chat itself (perf-audit
 * package WP7). Small enough that, unlike shell/editor below, it is not worth
 * idle-warming — loading it on the first click is fast and keeps one more
 * chunk off the boot path entirely for the common session that never opens it.
 */
export const loadBugReportDialog = () => import('../bug-report/BugReportDialog');

/**
 * The markdown renderer — react-markdown + remark-gfm + the micromark/mdast/
 * unified stack (~450 KB pre-minify, perf-audit package WP7) — is the single
 * biggest contributor to the entry chunk. `app_boot` (composer + conversation
 * list usable) never renders a message body, but opening any conversation
 * does, so unlike bug-report this one IS worth warming: by the time a user
 * picks a conversation the chunk has usually already loaded in an idle slice,
 * and `Markdown.tsx` shows a plain pre-wrap fallback for the rare cold case.
 */
export const loadMarkdownRenderer = () => import('../chat/view/subcomponents/MarkdownRenderer');

/**
 * Shell (xterm, ~400 KB) and the code editor (CodeMirror, ~690 KB) are the two
 * chunks big enough that fetching them at click time is felt. The markdown
 * renderer joins them here because almost every session opens a conversation
 * within seconds of boot, so warming it is a near-certain win rather than a
 * bet. Everything else that moved out of the entry chunk in issue #267 (and
 * bug-report, WP7) is small/rare enough to load on demand without warming.
 */
export const WARMABLE_SURFACES: SurfaceLoader[] = [loadStandaloneShell, loadEditorSidebar, loadMarkdownRenderer];
