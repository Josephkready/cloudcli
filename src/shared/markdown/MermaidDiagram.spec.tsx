import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider, useTheme } from '../../contexts/ThemeContext';

import MermaidDiagram from './MermaidDiagram';
import { resetMermaidRuntimeForTests } from './mermaidRuntimeLoader';

/*
 * The real mermaid runtime is mocked out here for two reasons, and the second
 * is the interesting one:
 *
 *   - jsdom has no layout engine, so `getBBox` does not exist and mermaid cannot
 *     measure text. Every diagram would "fail" for a reason a browser never has.
 *   - what this component actually owns is the DECISION TREE around mermaid, not
 *     mermaid: show the SVG when there is one, and fall back to the plain code
 *     block for every reason there is not. Driving the runtime's outcomes
 *     directly is the only way to assert all of them.
 *
 * A real browser rendering a real diagram is covered in `e2e/mermaid.spec.ts`.
 */
const { renderMermaid } = vi.hoisted(() => ({ renderMermaid: vi.fn() }));
vi.mock('./mermaidRuntime', () => ({ renderMermaid }));

const DIAGRAM = 'graph TD\n  A --> B\n';
const SVG = '<svg data-palette="light"><g><text>A</text></g></svg>';

function Fallback({ code = DIAGRAM }: { code?: string }) {
  return <pre data-testid="code-fallback">{code}</pre>;
}

function ThemeToggle() {
  const { toggleDarkMode } = useTheme();
  return (
    <button type="button" onClick={toggleDarkMode}>
      toggle theme
    </button>
  );
}

function renderDiagram(code = DIAGRAM) {
  return render(
    <ThemeProvider>
      <ThemeToggle />
      <MermaidDiagram code={code} fallback={<Fallback code={code} />} />
    </ThemeProvider>,
  );
}

/** The options object the component handed the runtime on its Nth render. */
function callOptions(index: number): { code: string; id: string; isDarkMode: boolean } {
  return renderMermaid.mock.calls[index][0];
}

describe('MermaidDiagram', () => {
  beforeEach(() => {
    resetMermaidRuntimeForTests();
    renderMermaid.mockReset();
  });

  it('replaces the code block with the rendered diagram', async () => {
    renderMermaid.mockResolvedValue(SVG);

    const { container } = renderDiagram();

    // The runtime is a lazy chunk, so the first paint is always the fallback.
    expect(screen.getByTestId('code-fallback')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument());
    expect(container.querySelector('svg[data-palette="light"]')).not.toBeNull();
    expect(screen.queryByTestId('code-fallback')).toBeNull();
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument();
  });

  it('keeps the source visible when the diagram does not parse', async () => {
    // THE case this feature has to survive: agents emit malformed mermaid all
    // the time, and a bad diagram must cost nothing more than the diagram.
    renderMermaid.mockResolvedValue(null);

    renderDiagram('graph TD\n  A -->');

    await waitFor(() => expect(renderMermaid).toHaveBeenCalled());
    expect(screen.getByTestId('code-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
    // The block shows its source, not an error, and nothing was thrown.
    expect(screen.getByTestId('code-fallback')).toHaveTextContent('graph TD');
  });

  it('keeps the source visible when mermaid itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderMermaid.mockRejectedValue(new Error('mermaid exploded'));

    renderDiagram();

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.getByTestId('code-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
  });

  it('falls back without touching the runtime for blank source', async () => {
    renderMermaid.mockResolvedValue(SVG);

    renderDiagram('   \n  ');

    await waitFor(() => expect(screen.getByTestId('code-fallback')).toBeInTheDocument());
    expect(renderMermaid).not.toHaveBeenCalled();
  });

  it('re-renders the diagram in the new palette when the theme is switched', async () => {
    // Mermaid bakes its colours into the SVG at render time, so a theme switch
    // has to re-render every diagram on screen or a dark transcript is left
    // showing a light-mode diagram.
    renderMermaid.mockResolvedValue(SVG);
    const user = userEvent.setup();

    const { container } = renderDiagram();
    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument());

    expect(renderMermaid).toHaveBeenCalledTimes(1);
    expect(callOptions(0).isDarkMode).toBe(false);

    renderMermaid.mockResolvedValue('<svg data-palette="dark"></svg>');
    await user.click(screen.getByRole('button', { name: 'toggle theme' }));

    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
    expect(callOptions(1).isDarkMode).toBe(true);
    await waitFor(() => expect(container.querySelector('svg[data-palette="dark"]')).not.toBeNull());
  });

  it('keeps the previous diagram on screen while a theme switch re-renders', async () => {
    renderMermaid.mockResolvedValue(SVG);
    const user = userEvent.setup();

    renderDiagram();
    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument());

    // A re-render that never settles: the old SVG must stay put rather than the
    // block flashing back to its source.
    renderMermaid.mockReturnValue(new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: 'toggle theme' }));

    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument();
    expect(screen.queryByTestId('code-fallback')).toBeNull();
  });

  // There is deliberately no "sets state after unmount" case here. React 18
  // removed that warning and a post-unmount `setState` is simply a no-op, so
  // such a test passes whether or not the effect's `cancelled` guard exists —
  // it would assert nothing. This one exercises the same guard on the path
  // where it IS observable.
  it('ignores a superseded render when the source changes mid-flight', async () => {
    let releaseStale: (value: string) => void = () => {};
    renderMermaid.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseStale = resolve;
      }),
    );

    const { rerender } = render(
      <ThemeProvider>
        <MermaidDiagram code="graph TD\n  A --> B" fallback={<Fallback />} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1));

    renderMermaid.mockResolvedValue('<svg data-palette="current"></svg>');
    rerender(
      <ThemeProvider>
        <MermaidDiagram code="graph LR\n  C --> D" fallback={<Fallback />} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument());

    // The first render finally lands, for source that is no longer on screen.
    releaseStale('<svg data-palette="stale"></svg>');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const diagram = screen.getByTestId('mermaid-diagram');
    expect(diagram.querySelector('svg[data-palette="current"]')).not.toBeNull();
    expect(diagram.querySelector('svg[data-palette="stale"]')).toBeNull();
  });

  it('hands mermaid a CSS-safe render id and the trimmed source', async () => {
    renderMermaid.mockResolvedValue(SVG);

    renderDiagram();

    await waitFor(() => expect(renderMermaid).toHaveBeenCalled());
    expect(callOptions(0).id).toMatch(/^mermaid-[a-zA-Z0-9_-]+$/);
    expect(callOptions(0).id).not.toContain(':');
    expect(callOptions(0).code).toBe('graph TD\n  A --> B');
  });

  it('contains a wide diagram instead of letting it widen the transcript', async () => {
    renderMermaid.mockResolvedValue(SVG);

    renderDiagram();

    const diagram = await screen.findByTestId('mermaid-diagram');
    expect(diagram.className).toContain('overflow-x-auto');
    // Without this the blanket `.chat-message * { max-width: 100% }` in
    // index.css shrinks the SVG to the column width instead of letting the box
    // scroll. jsdom has no cascade, so the real containment check lives in
    // `e2e/mermaid.spec.ts`; this only pins that the opt-out is still applied.
    expect(diagram.className).toContain('[&>svg]:max-w-none');
  });
});
