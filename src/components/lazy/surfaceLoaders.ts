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
 * Shell (xterm, ~400 KB) and the code editor (CodeMirror, ~690 KB) are the two
 * chunks big enough that fetching them at click time is felt. Everything else
 * that moved out of the entry chunk in issue #267 is small enough to load on
 * demand without warming.
 */
export const WARMABLE_SURFACES: SurfaceLoader[] = [loadStandaloneShell, loadEditorSidebar];
