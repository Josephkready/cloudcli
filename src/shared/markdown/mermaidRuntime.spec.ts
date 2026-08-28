import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderMermaid } from './mermaidRuntime';

/*
 * The render queue and the parse gate, tested against a faked mermaid.
 *
 * Every other spec mocks THIS module out, which left the two pieces of real
 * logic in it — "does not parse" short-circuits before rendering, and renders
 * are serialised — with no coverage at all. Faking the `mermaid` package instead
 * of the runtime is what makes them reachable: mermaid's own ESM build cannot
 * load under `tsx --test`, and in jsdom it has no layout engine to measure text
 * with, so a real mermaid would fail here for reasons a browser never has.
 *
 * What a real mermaid actually draws is covered by `e2e/mermaid.spec.ts`.
 */
const { initialize, parse, render } = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
}));
vi.mock('mermaid', () => ({ default: { initialize, parse, render } }));

const DIAGRAM = { code: 'graph TD\n  A --> B', id: 'mermaid-a', isDarkMode: false };

/** Let the queued promise chain drain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('renderMermaid', () => {
  beforeEach(() => {
    initialize.mockReset();
    parse.mockReset();
    render.mockReset();
  });

  it('returns the SVG mermaid produced', async () => {
    parse.mockResolvedValue({ diagramType: 'flowchart' });
    render.mockResolvedValue({ svg: '<svg id="drawn"></svg>' });

    await expect(renderMermaid(DIAGRAM)).resolves.toBe('<svg id="drawn"></svg>');
    expect(render).toHaveBeenCalledWith('mermaid-a', DIAGRAM.code);
  });

  it('returns null without rendering when the source does not parse', async () => {
    // The invalid-diagram path. It must be a value, not a throw: the caller
    // treats `null` as "show the source" and an exception as "mermaid broke".
    parse.mockResolvedValue(false);

    await expect(renderMermaid(DIAGRAM)).resolves.toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it('asks mermaid to suppress its own parse errors', async () => {
    // Without this a malformed diagram — routine in a chat transcript — logs a
    // stack on every render.
    parse.mockResolvedValue(false);

    await renderMermaid(DIAGRAM);

    expect(parse).toHaveBeenCalledWith(DIAGRAM.code, { suppressErrors: true });
  });

  it('applies the palette for the requested theme before each render', async () => {
    parse.mockResolvedValue(true);
    render.mockResolvedValue({ svg: '<svg></svg>' });

    await renderMermaid({ ...DIAGRAM, isDarkMode: true });
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));

    await renderMermaid({ ...DIAGRAM, isDarkMode: false });
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }));
  });

  it('serialises overlapping renders instead of interleaving them', async () => {
    // `mermaid.initialize()` mutates one module-global config and is NOT inside
    // mermaid's own execution queue, so two overlapping renders could otherwise
    // read each other's theme. A message with several diagrams mounts them all
    // in the same commit, so this is the ordinary case.
    parse.mockResolvedValue(true);
    let releaseFirst: (value: { svg: string }) => void = () => {};
    render
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ svg: 'second' });

    const first = renderMermaid({ ...DIAGRAM, id: 'mermaid-first' });
    const second = renderMermaid({ ...DIAGRAM, id: 'mermaid-second' });
    await flush();

    // The second render has not started while the first is still in flight.
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith('mermaid-first', DIAGRAM.code);

    releaseFirst({ svg: 'first' });

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith('mermaid-second', DIAGRAM.code);
  });

  it('keeps the queue alive after a render throws', async () => {
    // The queue chains on the SETTLED promise for this reason: chaining on the
    // render itself would leave one broken diagram blocking every later one.
    parse.mockResolvedValue(true);
    render.mockRejectedValueOnce(new Error('mermaid exploded')).mockResolvedValueOnce({ svg: 'after' });

    await expect(renderMermaid(DIAGRAM)).rejects.toThrow('mermaid exploded');
    await expect(renderMermaid(DIAGRAM)).resolves.toBe('after');
  });

  it('keeps the queue alive after a parse rejects outright', async () => {
    parse.mockRejectedValueOnce(new Error('parser exploded')).mockResolvedValueOnce(true);
    render.mockResolvedValue({ svg: 'recovered' });

    await expect(renderMermaid(DIAGRAM)).rejects.toThrow('parser exploded');
    await expect(renderMermaid(DIAGRAM)).resolves.toBe('recovered');
  });
});
