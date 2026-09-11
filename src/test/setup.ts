/**
 * Shared setup for the vitest component suite (`*.spec.ts`/`*.spec.tsx`).
 *
 * Everything here exists so individual tests stop hand-rolling the same stubs:
 * jsdom ships a DOM but omits a handful of browser APIs this app relies on
 * (`matchMedia`, `ResizeObserver`, `IntersectionObserver`, scrolling, the async
 * clipboard). Storage is real jsdom storage — it is only reset between tests so
 * one spec's `localStorage` writes can't leak into the next.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// Initialises i18next so components calling `t()` render the real English
// strings instead of raw keys. Vitest isolates modules per spec file, so this
// runs once per file — a spec that calls `i18n.changeLanguage()` would leak that
// language to later tests in the same file and should reset it itself.
import '@/i18n/config.js';

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

class StubObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = StubObserver as unknown as typeof ResizeObserver;
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = StubObserver as unknown as typeof IntersectionObserver;
}

// jsdom has no layout engine, so scrolling is either missing outright
// (`scrollIntoView`) or present as a stub that logs a noisy "Not implemented"
// error (`scrollTo`). The latter must be replaced unconditionally — it is a
// function already, so a `??` fallback would never fire.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
window.scrollTo = () => {};
window.HTMLElement.prototype.hasPointerCapture ??= () => false;
window.HTMLElement.prototype.releasePointerCapture ??= () => {};

// jsdom implements neither of these at all (not even as a stub that throws
// gracefully) — anything staging a client-side file preview (screenshots,
// image attachments) needs them.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => `blob:mock-${Math.random().toString(36).slice(2)}`);
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = vi.fn();
}

if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async () => {},
      readText: async () => '',
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.className = '';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
