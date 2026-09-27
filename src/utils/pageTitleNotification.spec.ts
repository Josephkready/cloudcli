import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module keeps its own top-level mutable state (the clear timer and
// whether "return" listeners are attached), so each test gets a fresh module
// instance via resetModules + dynamic import to avoid cross-test leakage.
async function freshModule() {
  vi.resetModules();
  return import('./pageTitleNotification');
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

function setFocused(focused: boolean) {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

describe('pageTitleNotification', () => {
  const originalTitle = document.title;

  beforeEach(() => {
    vi.useFakeTimers();
    document.title = 'CloudCLI UI';
    setVisibility('visible');
    setFocused(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.title = originalTitle;
    setVisibility('visible');
  });

  it('prefixes the current title with the [Done] indicator', async () => {
    document.title = 'My Session';
    const mod = await freshModule();

    mod.showCompletionTitleIndicator();

    expect(document.title).toBe('[Done] My Session');
  });

  it('does not double-prefix if the indicator is already present', async () => {
    document.title = '[Done] My Session';
    const mod = await freshModule();

    mod.showCompletionTitleIndicator();

    expect(document.title).toBe('[Done] My Session');
  });

  it('falls back to a default base title when document.title is empty', async () => {
    document.title = '';
    const mod = await freshModule();

    mod.showCompletionTitleIndicator();

    expect(document.title).toBe('[Done] CloudCLI UI');
  });

  it('auto-clears the indicator after 2s while the tab stays active/focused', async () => {
    const mod = await freshModule();
    mod.showCompletionTitleIndicator();
    expect(document.title).toBe('[Done] CloudCLI UI');

    await vi.advanceTimersByTimeAsync(2000);

    expect(document.title).toBe('CloudCLI UI');
  });

  it('keeps the indicator indefinitely once the tab goes hidden before the 2s clear fires', async () => {
    const mod = await freshModule();
    mod.showCompletionTitleIndicator();

    // Tab goes hidden before the scheduled clear — the pending timer must be
    // cancelled so the marker survives while the user is away.
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.advanceTimersByTimeAsync(10000);
    expect(document.title).toBe('[Done] CloudCLI UI');
  });

  it('clears the indicator once the user returns (visibilitychange back to visible+focused)', async () => {
    const mod = await freshModule();
    mod.showCompletionTitleIndicator();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(document.title).toBe('[Done] CloudCLI UI');

    // User returns: tab becomes visible and focused again.
    setVisibility('visible');
    setFocused(true);
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.advanceTimersByTimeAsync(2000);
    expect(document.title).toBe('CloudCLI UI');
  });

  it('attaches return listeners immediately when the indicator is shown while already inactive', async () => {
    setFocused(false);
    const mod = await freshModule();

    mod.showCompletionTitleIndicator();
    expect(document.title).toBe('[Done] CloudCLI UI');

    // Simulate the user clicking back into the (still not truly focused, per
    // our stub) page — an in-page click is the documented fallback trigger.
    setFocused(true);
    window.dispatchEvent(new MouseEvent('click'));

    await vi.advanceTimersByTimeAsync(2000);
    expect(document.title).toBe('CloudCLI UI');
  });

  it('a focus event while inactive-registered also triggers the return-to-clear flow', async () => {
    setFocused(false);
    const mod = await freshModule();
    mod.showCompletionTitleIndicator();

    setFocused(true);
    window.dispatchEvent(new Event('focus'));

    await vi.advanceTimersByTimeAsync(2000);
    expect(document.title).toBe('CloudCLI UI');
  });

  it('a return event while still inactive does nothing', async () => {
    setFocused(false);
    const mod = await freshModule();
    mod.showCompletionTitleIndicator();

    // Still not focused: dispatching click should not schedule a clear.
    window.dispatchEvent(new MouseEvent('click'));

    await vi.advanceTimersByTimeAsync(5000);
    expect(document.title).toBe('[Done] CloudCLI UI');
  });
});
