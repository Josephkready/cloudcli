import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import ImageAttachment from './ImageAttachment';

afterEach(() => {
  cleanup();
});

function makeFile(name = 'photo.png') {
  return new File(['fake image bytes'], name, { type: 'image/png' });
}

describe('ImageAttachment', () => {
  it('renders a preview image with an object URL and the file name as alt text', () => {
    const file = makeFile('cat.png');
    render(<ImageAttachment file={file} onRemove={() => {}} />);

    const img = screen.getByAltText('cat.png') as HTMLImageElement;
    expect(img.src).toMatch(/^blob:/);
  });

  it('revokes the object URL when unmounted', () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const file = makeFile();
    const { unmount } = render(<ImageAttachment file={file} onRemove={() => {}} />);
    unmount();
    expect(revokeSpy).toHaveBeenCalled();
  });

  it('calls onRemove when the remove button is clicked', () => {
    const onRemove = vi.fn();
    render(<ImageAttachment file={makeFile()} onRemove={onRemove} />);

    fireEvent.click(screen.getByRole('button', { name: /remove image/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('shows an upload progress overlay while uploadProgress < 100', () => {
    render(<ImageAttachment file={makeFile()} onRemove={() => {}} uploadProgress={42} />);
    expect(screen.getByText('42%')).toBeTruthy();
  });

  it('hides the progress overlay once uploadProgress reaches 100', () => {
    render(<ImageAttachment file={makeFile()} onRemove={() => {}} uploadProgress={100} />);
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('shows no progress overlay when uploadProgress is undefined', () => {
    render(<ImageAttachment file={makeFile()} onRemove={() => {}} />);
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it('shows an error overlay when error is set', () => {
    const { container } = render(
      <ImageAttachment file={makeFile()} onRemove={() => {}} error="upload failed" />,
    );
    expect(container.querySelector('.bg-red-500\\/50')).toBeTruthy();
  });

  it('re-derives the preview when the file prop changes', () => {
    const file1 = makeFile('one.png');
    const file2 = makeFile('two.png');
    const { rerender } = render(<ImageAttachment file={file1} onRemove={() => {}} />);
    expect(screen.getByAltText('one.png')).toBeTruthy();

    rerender(<ImageAttachment file={file2} onRemove={() => {}} />);
    expect(screen.getByAltText('two.png')).toBeTruthy();
  });
});
