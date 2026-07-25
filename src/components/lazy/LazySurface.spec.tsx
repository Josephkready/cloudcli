import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LazySurface, { lazySurface } from './LazySurface';

/*
 * Issue #267 moved every non-chat surface behind `React.lazy`, which converts
 * two previously impossible states into everyday ones: the surface is not here
 * yet, and the surface is never coming (a chunk request that fails). Neither
 * may take the app down with it — before this boundary existed, a throwing
 * child unmounted the whole tree and left a blank viewport.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('LazySurface', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The error boundary logs the caught error on purpose; React logs its own
    // copy too. Neither is interesting here.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('shows a skeleton while the chunk is in flight, then the surface', async () => {
    const gate = deferred<{ default: () => JSX.Element }>();
    const Surface = lazySurface(() => gate.promise);

    render(
      <LazySurface>
        <Surface />
      </LazySurface>,
    );

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('loaded surface')).toBeNull();

    gate.resolve({ default: () => <div>loaded surface</div> });

    expect(await screen.findByText('loaded surface')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders a caller-supplied fallback instead of the default skeleton', async () => {
    const gate = deferred<{ default: () => JSX.Element }>();
    const Surface = lazySurface(() => gate.promise);

    render(
      <LazySurface fallback={<p>opening editor</p>}>
        <Surface />
      </LazySurface>,
    );

    expect(await screen.findByText('opening editor')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();

    gate.resolve({ default: () => <div>loaded surface</div> });
    expect(await screen.findByText('loaded surface')).toBeInTheDocument();
  });

  it('renders nothing at all when the caller passes a null fallback', () => {
    const gate = deferred<{ default: () => JSX.Element }>();
    const Surface = lazySurface(() => gate.promise);

    const { container } = render(
      <LazySurface fallback={null}>
        <Surface />
      </LazySurface>,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('retries a chunk that fails once, without surfacing the failure', async () => {
    let attempts = 0;
    const Surface = lazySurface(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk request failed');
      return { default: () => <div>loaded surface</div> };
    });

    render(
      <LazySurface>
        <Surface />
      </LazySurface>,
    );

    expect(await screen.findByText('loaded surface', undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('shows a recoverable message — not a blank screen — when the chunk never arrives', async () => {
    const Surface = lazySurface(async () => {
      throw new Error('chunk request failed');
    });

    render(
      <div>
        <p>rest of the app</p>
        <LazySurface>
          <Surface />
        </LazySurface>
      </div>,
    );

    expect(
      await screen.findByText(/could not be loaded/i, undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    // The surface failing must not take its siblings with it.
    expect(screen.getByText('rest of the app')).toBeInTheDocument();
  });
});
