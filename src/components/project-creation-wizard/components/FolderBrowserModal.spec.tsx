import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const browseFilesystemFolders = vi.fn();
const createFolderInFilesystem = vi.fn();

vi.mock('../data/workspaceApi', () => ({
  browseFilesystemFolders: (...args: unknown[]) => browseFilesystemFolders(...args),
  createFolderInFilesystem: (...args: unknown[]) => createFolderInFilesystem(...args),
}));

const { default: FolderBrowserModal } = await import('./FolderBrowserModal');

const ROOT = '/var/tmp/cloudcli-audit';
const CHILD = `${ROOT}/demo-app`;

function renderPicker() {
  const onClose = vi.fn();
  const onFolderSelected = vi.fn();
  const result = render(
    <FolderBrowserModal
      isOpen
      autoAdvanceOnSelect={false}
      onClose={onClose}
      onFolderSelected={onFolderSelected}
    />,
  );
  return { ...result, onClose, onFolderSelected };
}

beforeEach(() => {
  browseFilesystemFolders.mockReset();
  createFolderInFilesystem.mockReset();
  browseFilesystemFolders.mockImplementation(async () => ({
    path: ROOT,
    isAtRoot: true,
    suggestions: [
      { name: 'demo-app', path: CHILD, type: 'directory', isRepository: true },
      { name: 'scratch', path: `${ROOT}/scratch`, type: 'directory', isRepository: false },
      { name: '.dotted', path: `${ROOT}/.dotted`, type: 'directory', isRepository: true },
    ],
  }));
});

/*
 * #309: the picker used to browse — every row descended a level, so choosing a
 * project meant wading through each repo's own src/, docs/, … It is now flat:
 * the repositories sitting in WORKSPACES_ROOT, and nothing below them. That
 * also subsumes #238's ".." row, since there is no navigation left to offer a
 * click that could only 403.
 */
describe('FolderBrowserModal — flat repository list (#309)', () => {
  it('asks the endpoint for repository flags when it opens', async () => {
    renderPicker();

    await waitFor(() => expect(browseFilesystemFolders).toHaveBeenCalled());
    expect(browseFilesystemFolders).toHaveBeenCalledWith('~', { includeRepositoryFlags: true });
  });

  it('lists repositories and leaves plain folders out', async () => {
    renderPicker();

    expect(await screen.findByRole('button', { name: /demo-app/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /scratch/ })).toBeNull();
  });

  it('selects a repository instead of descending into it', async () => {
    const user = userEvent.setup();
    const { onFolderSelected } = renderPicker();

    await user.click(await screen.findByRole('button', { name: /demo-app/ }));

    expect(onFolderSelected).toHaveBeenCalledWith(CHILD, false);
    // One browse, at open — clicking a row must not walk into the repo.
    expect(browseFilesystemFolders).toHaveBeenCalledTimes(1);
  });

  it('offers no ".." row, because there is nowhere above the root to go', async () => {
    renderPicker();

    await screen.findByRole('button', { name: /demo-app/ });
    expect(screen.queryByRole('button', { name: '..' })).toBeNull();
  });

  it('reveals the plain folders on request', async () => {
    const user = userEvent.setup();
    renderPicker();

    await screen.findByRole('button', { name: /demo-app/ });
    await user.click(screen.getByRole('button', { name: 'Show all folders' }));

    expect(screen.getByRole('button', { name: /scratch/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /demo-app/ })).toBeInTheDocument();
  });

  it('keeps hidden folders hidden until asked, even when they are repositories', async () => {
    const user = userEvent.setup();
    renderPicker();

    await screen.findByRole('button', { name: /demo-app/ });
    expect(screen.queryByRole('button', { name: /\.dotted/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show hidden folders' }));
    expect(screen.getByRole('button', { name: /\.dotted/ })).toBeInTheDocument();
  });

  it('says so plainly when the root holds no repositories', async () => {
    browseFilesystemFolders.mockResolvedValue({ path: ROOT, isAtRoot: true, suggestions: [] });
    renderPicker();

    expect(await screen.findByText('No repositories found')).toBeInTheDocument();
  });

  it('hands back the workspace root itself — the parent a clone lands in', async () => {
    const user = userEvent.setup();
    const { onFolderSelected } = renderPicker();

    await screen.findByRole('button', { name: /demo-app/ });
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));

    expect(onFolderSelected).toHaveBeenCalledWith(ROOT, false);
  });

  it('hands a newly created folder straight back rather than losing it to the filter', async () => {
    const user = userEvent.setup();
    createFolderInFilesystem.mockResolvedValue(`${ROOT}/fresh-idea`);
    const { onFolderSelected } = renderPicker();

    await screen.findByRole('button', { name: /demo-app/ });
    await user.click(screen.getByRole('button', { name: 'Create new folder' }));
    await user.type(screen.getByPlaceholderText('New folder name'), 'fresh-idea');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createFolderInFilesystem).toHaveBeenCalledWith(`${ROOT}/fresh-idea`),
    );
    // A brand-new folder is never a repository, so leaving it in the list would
    // mean creating something the default filter immediately swallows.
    await waitFor(() => expect(onFolderSelected).toHaveBeenCalledWith(`${ROOT}/fresh-idea`, false));
  });
});

/*
 * #243: the picker was a hand-rolled `fixed inset-0` overlay that never opted
 * into Esc or backdrop dismissal, while /help, /status and Token Usage all
 * close on Esc — so users learn Esc works, then hit a dialog where it doesn't.
 */
describe('FolderBrowserModal — Esc and backdrop dismissal (#243)', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker();

    await screen.findByRole('button', { name: /demo-app/ });
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click on the backdrop but not inside the dialog', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker();

    const dialog = await screen.findByRole('dialog', { name: 'Select Folder' });
    await user.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    await user.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets the inline new-folder field own the first Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker();

    await screen.findByRole('button', { name: /demo-app/ });
    await user.click(screen.getByRole('button', { name: 'Create new folder' }));

    const nameField = screen.getByPlaceholderText('New folder name');
    await user.keyboard('{Escape}');

    // First Escape cancels the inline field, leaving the picker open.
    expect(nameField).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // A second Escape then closes the picker itself.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives the close button an accessible name', async () => {
    renderPicker();

    await screen.findByRole('button', { name: /demo-app/ });
    expect(screen.getByRole('button', { name: 'Close folder browser' })).toBeInTheDocument();
  });
});

/*
 * #274: #243 fixed dismissal but not focus, so Tab walked straight out of the
 * picker and into the page behind it while the overlay covered the screen.
 */
describe('FolderBrowserModal — focus trap (#274)', () => {
  function renderPickerOverPage() {
    const onClose = vi.fn();
    const onFolderSelected = vi.fn();
    const result = render(
      <>
        <button type="button">behind the picker</button>
        <FolderBrowserModal
          isOpen
          autoAdvanceOnSelect={false}
          onClose={onClose}
          onFolderSelected={onFolderSelected}
        />
      </>,
    );
    return { ...result, onClose, onFolderSelected };
  }

  it('moves focus into the picker when it opens', async () => {
    renderPickerOverPage();

    const dialog = await screen.findByRole('dialog', { name: 'Select Folder' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('wraps Tab from the last control back to the first', async () => {
    const user = userEvent.setup();
    renderPickerOverPage();

    await screen.findByRole('button', { name: /demo-app/ });
    screen.getByRole('button', { name: 'Use this folder' }).focus();
    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show all folders' }));
  });

  it('wraps Shift+Tab from the first control to the last', async () => {
    const user = userEvent.setup();
    renderPickerOverPage();

    await screen.findByRole('button', { name: /demo-app/ });
    screen.getByRole('button', { name: 'Show all folders' }).focus();
    await user.tab({ shift: true });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Use this folder' }));
  });

  it('never lets Tab reach the page behind the picker', async () => {
    const user = userEvent.setup();
    renderPickerOverPage();

    const dialog = await screen.findByRole('dialog', { name: 'Select Folder' });
    const behind = screen.getByRole('button', { name: 'behind the picker' });

    for (let press = 0; press < 10; press += 1) {
      await user.tab();
      expect(document.activeElement).not.toBe(behind);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('restores focus to the opener when the picker closes', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.append(opener);
    opener.focus();

    const { rerender } = render(
      <FolderBrowserModal
        isOpen={false}
        autoAdvanceOnSelect={false}
        onClose={vi.fn()}
        onFolderSelected={vi.fn()}
      />,
    );

    rerender(
      <FolderBrowserModal
        isOpen
        autoAdvanceOnSelect={false}
        onClose={vi.fn()}
        onFolderSelected={vi.fn()}
      />,
    );
    await screen.findByRole('button', { name: /demo-app/ });
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <FolderBrowserModal
        isOpen={false}
        autoAdvanceOnSelect={false}
        onClose={vi.fn()}
        onFolderSelected={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
