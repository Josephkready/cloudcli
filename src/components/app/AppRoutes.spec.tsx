import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import AppRoutes from './AppRoutes';

/*
 * Unknown routes used to black-hole (#233). React Router matched nothing and
 * rendered nothing, so `document.body.innerText` was the empty string and the
 * viewport was a solid background-coloured rectangle. Because the server serves
 * `dist/index.html` for unknown paths (SPA fallback) the request even succeeded
 * with HTTP 200, so the browser gave no error either — the only way out was to
 * hand-edit the URL.
 */

vi.mock('./AppContent', () => ({
  default: () => <div data-testid="app-content">app content</div>,
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('AppRoutes — unknown paths (#233)', () => {
  it('renders something for a path the router does not know', () => {
    const { container } = renderAt('/does-not-exist-at-all');

    expect(container.textContent?.trim()).not.toBe('');
  });

  it('tells the user the page was not found rather than showing a blank pane', () => {
    renderAt('/does-not-exist-at-all');

    expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    expect(screen.queryByTestId('app-content')).toBeNull();
  });

  it('offers a way back to the app', async () => {
    renderAt('/does-not-exist-at-all');

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/');

    await userEvent.click(link);
    expect(screen.getByTestId('app-content')).toBeInTheDocument();
  });

  it('still renders the app at / and at a session route', () => {
    renderAt('/');
    expect(screen.getByTestId('app-content')).toBeInTheDocument();
  });

  it('leaves unknown session ids alone — they degrade gracefully inside the app', () => {
    renderAt('/session/00000000-0000-0000-0000-000000000000');

    expect(screen.getByTestId('app-content')).toBeInTheDocument();
    expect(screen.queryByText(/page not found/i)).toBeNull();
  });
});
