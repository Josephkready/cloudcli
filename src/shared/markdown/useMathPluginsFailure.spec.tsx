import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getLoadedMathRuntime, loadMathRuntime, resetMathRuntimeForTests, useMathPlugins } from './useMathPlugins';

// Its own file because `vi.mock` is hoisted per module graph: this whole spec
// runs against a `mathRuntime` chunk that refuses to load, which is what an
// offline or mid-deploy user hits. The success paths live in
// useMathPlugins.spec.tsx.
vi.mock('./mathRuntime', () => {
  throw new Error('simulated chunk load failure');
});

describe('useMathPlugins when the KaTeX chunk fails to load', () => {
  beforeEach(() => {
    resetMathRuntimeForTests();
  });

  it('degrades to literal text and warns instead of throwing into the render', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useMathPlugins('The area is $$x^2$$.'));

    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(warn.mock.calls[0]?.[0]).toContain('Failed to load KaTeX math renderer');
    // No plugins means ReactMarkdown renders `$$x^2$$` as ordinary text — the
    // message stays readable rather than disappearing behind an error boundary.
    expect(result.current.remarkMathPlugins).toHaveLength(0);
    expect(result.current.rehypeMathPlugins).toHaveLength(0);
    expect(getLoadedMathRuntime()).toBeNull();
  });

  it('does not poison the cache, so a later math message retries', async () => {
    const first = loadMathRuntime();
    await expect(first).rejects.toThrow();

    // A cached rejected promise would make every later attempt fail instantly
    // with the stale error. Clearing `pendingLoad` on failure means the second
    // call is a genuinely new attempt, not the same settled promise handed back.
    const second = loadMathRuntime();
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();

    expect(getLoadedMathRuntime()).toBeNull();
  });

  it('never reaches the loader at all for math-free content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useMathPlugins('It costs $5 and $10, no math involved.'));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).not.toHaveBeenCalled();
    expect(result.current.remarkMathPlugins).toHaveLength(0);
  });
});
