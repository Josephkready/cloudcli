import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import QueuedMessageCard from './QueuedMessageCard';

afterEach(() => {
  cleanup();
});

describe('QueuedMessageCard', () => {
  it('renders the queued content and calls onEdit/onDelete', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<QueuedMessageCard content="Do the next thing" onEdit={onEdit} onDelete={onDelete} />);

    expect(screen.getByText('Do the next thing')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /edit queued message/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /delete queued message/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not show an image count when imageCount is 0 (default)', () => {
    render(<QueuedMessageCard content="text only" onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.queryByText(/attached/)).toBeNull();
  });

  it('shows singular "image" for a count of 1', () => {
    render(<QueuedMessageCard content="with pic" imageCount={1} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByText('1 image attached')).toBeTruthy();
  });

  it('shows plural "images" for a count > 1', () => {
    render(<QueuedMessageCard content="with pics" imageCount={3} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByText('3 images attached')).toBeTruthy();
  });
});
