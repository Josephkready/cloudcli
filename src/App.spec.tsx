import { render, screen } from '@testing-library/react';
import { useHref } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * App wires the whole provider stack (theme / auth / websocket / plugins) around a
 * React Router `basename` that is *detected*, not configured: cloudcli can be served
 * from a path prefix by a reverse proxy (e.g. /ai/assets/index-abc123.js), and the
 * packaged app must also keep working when served directly from the domain root. The
 * providers themselves are exercised by their own tests — this spec only cares that
 * App (a) renders the tree without throwing and (b) feeds the right basename to the
 * Router by reading `document.head` / `window.__ROUTER_BASENAME__` before it exists.
 */

vi.mock('./contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./components/auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./contexts/WebSocketContext', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./contexts/PluginsContext', () => ({
  PluginsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Probes what basename the Router around it actually resolved, without needing to
// reach into React Router's internals: `useHref('/')` returns the root href prefixed
// by the basename the surrounding `<Router>` was given.
vi.mock('./components/app/AppRoutes', () => ({
  default: () => {
    const RootHrefProbe = () => <div data-testid="root-href">{useHref('/')}</div>;
    return <RootHrefProbe />;
  },
}));

import App from './App';

function setHead(html: string) {
  document.head.innerHTML = html;
}

describe('App', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    delete (window as unknown as { __ROUTER_BASENAME__?: string }).__ROUTER_BASENAME__;
    window.history.pushState({}, '', '/');
  });

  it('renders the app tree without crashing', () => {
    render(<App />);
    expect(screen.getByTestId('root-href')).toBeInTheDocument();
  });

  it('uses an explicit window.__ROUTER_BASENAME__ over any DOM hints, trimming a trailing slash', () => {
    (window as unknown as { __ROUTER_BASENAME__?: string }).__ROUTER_BASENAME__ = '/explicit/';
    setHead('<script type="module" src="/ai/assets/index-abc123.js"></script>');
    window.history.pushState({}, '', '/explicit/');

    render(<App />);
    expect(screen.getByTestId('root-href').textContent).toBe('/explicit');
  });

  it('detects no basename for a root deployment (script src with no prefix)', () => {
    setHead('<script type="module" src="/assets/index-abc123.js"></script>');

    render(<App />);
    expect(screen.getByTestId('root-href').textContent).toBe('/');
  });

  it('detects a basename from a module script served under a path prefix', () => {
    setHead('<script type="module" src="/ai/assets/index-abc123.js"></script>');
    window.history.pushState({}, '', '/ai/');

    render(<App />);
    expect(screen.getByTestId('root-href').textContent).toBe('/ai');
  });

  it('detects a basename from the manifest link', () => {
    setHead('<link rel="manifest" href="/ai/manifest.json">');
    window.history.pushState({}, '', '/ai/');

    render(<App />);
    expect(screen.getByTestId('root-href').textContent).toBe('/ai');
  });

  it('strips the icons directory from a root-deployed favicon so it is not mistaken for a basename', () => {
    setHead('<link rel="icon" href="/icons/icon-512x512.png">');

    render(<App />);
    expect(screen.getByTestId('root-href').textContent).toBe('/');
  });

  it('keeps a real prefix ahead of the icons directory it strips', () => {
    setHead('<link rel="icon" href="/ai/icons/icon-512x512.png">');
    window.history.pushState({}, '', '/ai/');

    render(<App />);
    expect(screen.getByTestId('root-href').textContent).toBe('/ai');
  });

  it('ignores a candidate whose resolved origin differs from the page origin', () => {
    setHead('<link rel="manifest" href="https://cdn.example.com/ai/manifest.json">');

    render(<App />);
    expect(screen.getByTestId('root-href').textContent).toBe('/');
  });

  it('picks the longest detected basename across multiple hints', () => {
    setHead(`
      <link rel="icon" href="/icons/icon-512x512.png">
      <script type="module" src="/ai/nested/assets/index-abc123.js"></script>
    `);
    window.history.pushState({}, '', '/ai/nested/');

    render(<App />);
    expect(screen.getByTestId('root-href').textContent).toBe('/ai/nested');
  });
});
