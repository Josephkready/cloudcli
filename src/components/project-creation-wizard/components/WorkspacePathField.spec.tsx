import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const browseFilesystemFolders = vi.fn();

vi.mock('../data/workspaceApi', () => ({
  browseFilesystemFolders: (...args: unknown[]) => browseFilesystemFolders(...args),
}));

const { default: WorkspacePathField } = await import('./WorkspacePathField');

function renderField(overrides: Partial<Parameters<typeof WorkspacePathField>[0]> = {}) {
  const onChange = vi.fn();
  const onAdvanceToConfirm = vi.fn();

  const props = {
    value: '',
    onChange,
    onAdvanceToConfirm,
    ...overrides,
  };

  const result = render(<WorkspacePathField {...props} />);
  return { ...result, onChange, onAdvanceToConfirm };
}

beforeEach(() => {
  browseFilesystemFolders.mockReset();
  browseFilesystemFolders.mockResolvedValue({
    path: '/home/user',
    isAtRoot: false,
    suggestions: [],
  });
});

describe('WorkspacePathField', () => {
  it('renders the given value in the text input', () => {
    renderField({ value: '/tmp/demo' });

    expect(screen.getByPlaceholderText('/path/to/project/workspace')).toHaveValue('/tmp/demo');
  });

  it('calls onChange as the user types', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField({ value: '' });

    await user.type(screen.getByPlaceholderText('/path/to/project/workspace'), 'x');

    expect(onChange).toHaveBeenCalledWith('x');
  });

  it('does not query for suggestions while the value is 2 characters or fewer', async () => {
    renderField({ value: 'ab' });

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(browseFilesystemFolders).not.toHaveBeenCalled();
  });

  it('shows matching path suggestions after debounce once the value is longer', async () => {
    browseFilesystemFolders.mockResolvedValue({
      path: '/home/user',
      isAtRoot: false,
      suggestions: [
        { name: 'projects', path: '/home/user/projects', type: 'directory' },
        { name: 'other', path: '/home/user/other-thing', type: 'directory' },
      ],
    });

    renderField({ value: '/home/user/pro' });

    await waitFor(() => expect(browseFilesystemFolders).toHaveBeenCalled(), { timeout: 1000 });
    expect(await screen.findByText('projects')).toBeInTheDocument();
    expect(screen.queryByText('other')).toBeNull();
  });

  it('picking a suggestion calls onChange with its path and closes the dropdown', async () => {
    browseFilesystemFolders.mockResolvedValue({
      path: '/home/user',
      isAtRoot: false,
      suggestions: [{ name: 'projects', path: '/home/user/projects', type: 'directory' }],
    });
    const user = userEvent.setup();
    const { onChange } = renderField({ value: '/home/user/pro' });

    const suggestionButton = await screen.findByRole('button', { name: /projects/ });
    await user.click(suggestionButton);

    expect(onChange).toHaveBeenCalledWith('/home/user/projects');
    await waitFor(() => expect(screen.queryByText('/home/user/projects')).toBeNull());
  });

  it('opens the folder browser modal when "Browse folders" is clicked', async () => {
    const user = userEvent.setup();
    renderField({ value: '' });

    await user.click(screen.getByRole('button', { name: 'Browse folders' }));

    expect(await screen.findByRole('dialog', { name: 'Select Folder' })).toBeInTheDocument();
  });

  it('logs and does not crash when the suggestion lookup rejects', async () => {
    browseFilesystemFolders.mockRejectedValue(new Error('boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderField({ value: '/home/user/pro' });

    await waitFor(() => expect(browseFilesystemFolders).toHaveBeenCalled(), { timeout: 1000 });
    await waitFor(() => expect(consoleError).toHaveBeenCalled());

    consoleError.mockRestore();
  });

  it('disables the input and browse button when disabled is true', () => {
    renderField({ value: '', disabled: true });

    expect(screen.getByPlaceholderText('/path/to/project/workspace')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Browse folders' })).toBeDisabled();
  });
});
