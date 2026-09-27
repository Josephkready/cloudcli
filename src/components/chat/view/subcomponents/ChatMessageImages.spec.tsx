import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import ChatMessageImages from './ChatMessageImages';
import { authenticatedFetch } from '../../../../utils/api';

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(authenticatedFetch);

function makeBlobResponse() {
  return {
    ok: true,
    blob: () => Promise.resolve(new Blob(['fake'])),
  } as unknown as Response;
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('ChatMessageImages', () => {
  it('renders nothing when there are no images', () => {
    const { container } = render(<ChatMessageImages images={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a null/undefined images list', () => {
    const { container } = render(<ChatMessageImages images={undefined as unknown as []} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an inline data-url image directly without fetching', async () => {
    render(<ChatMessageImages images={[{ data: 'data:image/png;base64,AAAA', name: 'shot.png' }]} />);

    const img = await screen.findByRole('img', { name: 'shot.png' });
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('fetches a path-based image from the global assets route and shows it', async () => {
    mockedFetch.mockResolvedValueOnce(makeBlobResponse());

    render(<ChatMessageImages images={[{ path: '/some/dir/pic.png', name: 'pic' }]} />);

    // Loading placeholder first (no alt text, animate-pulse box).
    await waitFor(() => expect(screen.getByRole('img', { name: 'pic' })).toBeInTheDocument());

    expect(mockedFetch).toHaveBeenCalledWith(
      '/api/assets/images/pic.png',
      expect.objectContaining({ signal: expect.anything() }),
    );
    const img = screen.getByRole('img', { name: 'pic' });
    expect(img.getAttribute('src')).toMatch(/^blob:/);
  });

  it('falls back to the project files route when the assets route fails', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: false } as unknown as Response);
    mockedFetch.mockResolvedValueOnce(makeBlobResponse());

    render(<ChatMessageImages images={[{ path: '/some/dir/pic.png', name: 'pic' }]} projectId="proj-1" />);

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    expect(mockedFetch).toHaveBeenNthCalledWith(
      2,
      '/api/projects/proj-1/files/content?path=%2Fsome%2Fdir%2Fpic.png',
      expect.objectContaining({ signal: expect.anything() }),
    );
    await waitFor(() => expect(screen.getByRole('img', { name: 'pic' })).toBeInTheDocument());
  });

  it('shows a failed placeholder with the alt text when every candidate URL fails', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: false } as unknown as Response);

    render(<ChatMessageImages images={[{ path: '/x/broken.png', name: 'Broken Image' }]} />);

    expect(await screen.findByText('Broken Image')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows a failed placeholder immediately when the image has neither data nor path', async () => {
    render(<ChatMessageImages images={[{ name: 'Nothing here' }]} />);
    expect(await screen.findByText('Nothing here')).toBeInTheDocument();
  });

  it('shows a failed placeholder when fetch rejects with a non-abort error', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('network down'));

    render(<ChatMessageImages images={[{ path: '/x/oops.png', name: 'Oops' }]} />);

    expect(await screen.findByText('Oops')).toBeInTheDocument();
  });

  it('defaults the alt text to "Attached image" when no name is given', async () => {
    render(<ChatMessageImages images={[{ data: 'data:image/png;base64,AAAA' }]} />);
    expect(await screen.findByRole('img', { name: 'Attached image' })).toBeInTheDocument();
  });

  it('expands to a lightbox on click and closes on backdrop click', async () => {
    render(<ChatMessageImages images={[{ data: 'data:image/png;base64,AAAA', name: 'shot' }]} />);

    const expandButton = await screen.findByRole('button', { name: 'Expand shot' });
    fireEvent.click(expandButton);

    const dialog = await screen.findByRole('dialog', { name: 'shot' });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes the lightbox via the close button without navigating away', async () => {
    render(<ChatMessageImages images={[{ data: 'data:image/png;base64,AAAA', name: 'shot' }]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Expand shot' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close image preview' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes the lightbox on Escape and clicking the image itself does not close it', async () => {
    render(<ChatMessageImages images={[{ data: 'data:image/png;base64,AAAA', name: 'shot' }]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Expand shot' }));
    const dialog = await screen.findByRole('dialog', { name: 'shot' });
    const lightboxImg = dialog.querySelector('img') as HTMLImageElement;
    fireEvent.click(lightboxImg);
    expect(screen.getByRole('dialog', { name: 'shot' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('renders multiple images side by side', async () => {
    render(
      <ChatMessageImages
        images={[
          { data: 'data:image/png;base64,AAAA', name: 'first' },
          { data: 'data:image/png;base64,BBBB', name: 'second' },
        ]}
      />,
    );

    expect(await screen.findByRole('img', { name: 'first' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'second' })).toBeInTheDocument();
  });
});
