import { describe, expect, it } from 'vitest';

import {
  loadBugReportDialog,
  loadMarkdownRenderer,
  loadStandaloneShell,
  WARMABLE_SURFACES,
} from './surfaceLoaders';

/**
 * `WARMABLE_SURFACES` and the `lazySurface(...)` call sites that actually gate
 * each component are declared separately (see the module doc comment) so they
 * can drift apart silently — a loader added to one without the other either
 * warms a chunk nobody needs or leaves a click cold with no warning from any
 * component test. This pins the array's contents directly.
 */
describe('WARMABLE_SURFACES', () => {
  it('warms exactly the shell', () => {
    expect(WARMABLE_SURFACES).toEqual([loadStandaloneShell]);
  });

  it('does not idle-warm markdown — Markdown.tsx loads it eagerly at module evaluation', () => {
    expect(WARMABLE_SURFACES).not.toContain(loadMarkdownRenderer);
  });

  it('does not warm bug-report — small/rare enough to load on first click', () => {
    expect(WARMABLE_SURFACES).not.toContain(loadBugReportDialog);
  });

  it('every warmable loader resolves to a real module with a default export', async () => {
    for (const load of WARMABLE_SURFACES) {
      const mod = (await load()) as { default?: unknown };
      expect(mod.default).toBeDefined();
    }
    // Evaluates the real xterm module graph, which can take well
    // over the default 5s when the full suite runs on a loaded machine.
  }, 30_000);
});
