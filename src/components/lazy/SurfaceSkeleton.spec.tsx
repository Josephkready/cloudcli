import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SurfaceSkeleton from './SurfaceSkeleton';

/*
 * Suspense fallback for a lazily-loaded surface (#267). Deliberately layout-shaped
 * rather than a spinner — both the in-flow pane and the overlay variant are covered
 * here, since only LazySurface's tests exercised this component before, and only
 * indirectly (never with `overlay`).
 */
describe('SurfaceSkeleton', () => {
  it('renders an in-flow pane by default with the default label announced to assistive tech', () => {
    render(<SurfaceSkeleton />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('announces a custom label', () => {
    render(<SurfaceSkeleton label="Loading settings…" />);
    expect(screen.getByText('Loading settings…')).toBeInTheDocument();
  });

  it('renders as a centred overlay when overlay is true', () => {
    const { container } = render(<SurfaceSkeleton overlay />);

    expect(container.querySelector('.fixed.inset-0')).toBeInTheDocument();
  });

  it('does not render the overlay wrapper by default', () => {
    const { container } = render(<SurfaceSkeleton />);

    expect(container.querySelector('.fixed.inset-0')).toBeNull();
  });

  it('merges a custom className onto the pane', () => {
    render(<SurfaceSkeleton className="my-extra-class" />);

    expect(screen.getByRole('status')).toHaveClass('my-extra-class');
  });
});
