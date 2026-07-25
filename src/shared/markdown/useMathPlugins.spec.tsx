import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getLoadedMathRuntime,
  loadMathRuntime,
  resetMathRuntimeForTests,
  useMathPlugins,
} from './useMathPlugins';

describe('useMathPlugins', () => {
  beforeEach(() => {
    resetMathRuntimeForTests();
  });

  it('loads nothing for markdown without math', async () => {
    const { result } = renderHook(() => useMathPlugins('Just a paragraph that costs $5 and $10.'));

    expect(result.current.remarkMathPlugins).toHaveLength(0);
    expect(result.current.rehypeMathPlugins).toHaveLength(0);

    // Give a stray dynamic import a chance to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getLoadedMathRuntime()).toBeNull();
  });

  it('loads the KaTeX runtime on demand for markdown with math', async () => {
    const { result } = renderHook(() => useMathPlugins('The area is $$x^2$$.'));

    // First render is deliberately math-free: the message shows as literal text
    // for exactly as long as the chunk fetch takes.
    expect(result.current.remarkMathPlugins).toHaveLength(0);

    // Generous timeout: this is the one test that pays for the cold transform of
    // the whole KaTeX chunk, which can exceed RTL's 1s default on a loaded box.
    await waitFor(
      () => {
        expect(result.current.remarkMathPlugins).toHaveLength(1);
      },
      { timeout: 20_000 },
    );
    expect(result.current.rehypeMathPlugins).toHaveLength(1);
    expect(getLoadedMathRuntime()).not.toBeNull();
  }, 30_000);

  it('serves the cached runtime synchronously once loaded', async () => {
    await loadMathRuntime();

    const { result } = renderHook(() => useMathPlugins('Inline $\\alpha$ math.'));

    // No flash on the second math message — the plugins are there on render 1.
    expect(result.current.remarkMathPlugins).toHaveLength(1);
    expect(result.current.rehypeMathPlugins).toHaveLength(1);
  });

  it('keeps the same plugin arrays across re-renders with equivalent content', async () => {
    await loadMathRuntime();

    const { result, rerender } = renderHook(({ content }) => useMathPlugins(content), {
      initialProps: { content: 'Inline $x^2$ math.' },
    });
    const first = result.current;

    rerender({ content: 'Inline $x^2$ math.' });

    expect(result.current.remarkMathPlugins).toBe(first.remarkMathPlugins);
  });

  it('switches to empty plugins when the content loses its math', async () => {
    await loadMathRuntime();

    const { result, rerender } = renderHook(({ content }) => useMathPlugins(content), {
      initialProps: { content: '$x^2$' },
    });
    expect(result.current.remarkMathPlugins).toHaveLength(1);

    rerender({ content: 'no math here' });
    expect(result.current.remarkMathPlugins).toHaveLength(0);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const [a, b] = await Promise.all([loadMathRuntime(), loadMathRuntime()]);
    expect(a).toBe(b);
    expect(a).toBe(getLoadedMathRuntime());
  });
});
