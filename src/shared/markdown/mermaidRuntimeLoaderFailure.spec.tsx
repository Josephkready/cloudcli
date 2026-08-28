import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../contexts/ThemeContext';

import MermaidDiagram from './MermaidDiagram';
import { getLoadedMermaidRuntime, loadMermaidRuntime, resetMermaidRuntimeForTests } from './mermaidRuntimeLoader';

// Its own file because `vi.mock` is hoisted per module graph: this whole spec
// runs against a `mermaidRuntime` chunk that refuses to load, which is what an
// offline user — or one mid-deploy, holding an index chunk that names assets the
// server no longer has — actually hits. The success paths live in
// MermaidDiagram.spec.tsx.
//
// Mirrors useMathPluginsFailure.spec.tsx, which pins the identical contract for
// the KaTeX chunk.
vi.mock('./mermaidRuntime', () => {
  throw new Error('simulated chunk load failure');
});

describe('MermaidDiagram when the mermaid chunk fails to load', () => {
  beforeEach(() => {
    resetMermaidRuntimeForTests();
  });

  it('keeps showing the source and warns instead of throwing into the render', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <ThemeProvider>
        <MermaidDiagram code="graph TD\n  A --> B" fallback={<pre data-testid="code-fallback">source</pre>} />
      </ThemeProvider>,
    );

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(String(warn.mock.calls[0]?.[0])).toContain('Mermaid failed to render');
    // The message survives a chunk that never arrives: the fence renders as the
    // ordinary code block it was before this feature existed.
    expect(screen.getByTestId('code-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
    expect(getLoadedMermaidRuntime()).toBeNull();
  });

  it('does not poison the cache, so a later diagram retries', async () => {
    const first = loadMermaidRuntime();
    await expect(first).rejects.toThrow();

    // A cached rejected promise would make every later attempt fail instantly
    // with the stale error — one dropped chunk fetch and diagrams stay broken
    // for the rest of the session. Clearing `pendingLoad` on failure means the
    // second call is a genuinely new attempt, not the same settled promise.
    const second = loadMermaidRuntime();
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();

    expect(getLoadedMermaidRuntime()).toBeNull();
  });
});
