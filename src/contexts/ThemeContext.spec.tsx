import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider, useTheme } from './ThemeContext';

/*
 * #371: index.html ships two media-queried `theme-color` metas (light + dark) so
 * the pre-JS chrome matches the OS scheme. Once a theme is applied, ThemeContext
 * must drive BOTH metas to the applied colour (via querySelectorAll, not the old
 * single-meta querySelector) so an explicit in-app theme that differs from the OS
 * scheme still wins — and it must keep the iOS status-bar style in step.
 */

function Consumer() {
  const { isDarkMode, toggleDarkMode } = useTheme();
  return (
    <button type="button" onClick={toggleDarkMode}>
      {isDarkMode ? 'dark' : 'light'}
    </button>
  );
}

function themeColorContents() {
  return Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) =>
    m.getAttribute('content'),
  );
}

function statusBarStyle() {
  return document
    .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.getAttribute('content');
}

describe('ThemeContext theme-color sync (#371)', () => {
  beforeEach(() => {
    localStorage.clear();
    // The metas index.html ships: a light and a dark media-queried theme-color,
    // plus the iOS status-bar style.
    document.head.innerHTML = `
      <meta name="theme-color" content="#f7f6f3" media="(prefers-color-scheme: light)">
      <meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)">
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    document.head.innerHTML = '';
    localStorage.clear();
  });

  it('drives BOTH theme-color metas (and the status bar) to the applied theme', () => {
    localStorage.setItem('theme', 'light');
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );

    // Light: both metas collapse to the light colour, overriding the dark media
    // meta's own value so the running app's chrome is a single applied colour.
    expect(themeColorContents()).toEqual(['#f7f6f3', '#f7f6f3']);
    expect(statusBarStyle()).toBe('default');

    fireEvent.click(screen.getByRole('button'));

    // Dark: both metas + the status bar follow.
    expect(themeColorContents()).toEqual(['#141414', '#141414']);
    expect(statusBarStyle()).toBe('black-translucent');
  });

  it('falls back to the system theme when storage access is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);

    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );

    expect(screen.getByRole('button')).toHaveTextContent('dark');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('light');
  });
});
