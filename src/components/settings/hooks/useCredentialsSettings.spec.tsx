import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
const copyTextToClipboard = vi.fn();

vi.mock('@/utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

vi.mock('@/utils/clipboard', () => ({
  copyTextToClipboard: (...args: unknown[]) => copyTextToClipboard(...args),
}));

const { useCredentialsSettings } = await import('./useCredentialsSettings');

type Controller = ReturnType<typeof useCredentialsSettings>;
let controller: Controller;

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    json: async () => body,
  } as unknown as Response);
}

function Harness() {
  controller = useCredentialsSettings({
    confirmDeleteApiKeyText: 'Delete this key?',
    confirmDeleteGithubCredentialText: 'Delete this credential?',
  });
  return (
    <div>
      <div data-testid="loading">{String(controller.loading)}</div>
      <div data-testid="apiKeys">{controller.apiKeys.length}</div>
      <div data-testid="githubCreds">{controller.githubCredentials.length}</div>
      <div data-testid="copiedKey">{controller.copiedKey ?? ''}</div>
      <div data-testid="newlyCreatedKey">{controller.newlyCreatedKey?.apiKey ?? ''}</div>
    </div>
  );
}

const defaultApiKeys = [
  { id: 'k1', key_name: 'Key One', api_key: 'sk-1', created_at: '2024-01-01', is_active: true },
];
const defaultGithubCreds = [
  { id: 'g1', credential_name: 'Cred One', created_at: '2024-01-01', is_active: true },
];

beforeEach(() => {
  authenticatedFetch.mockReset();
  copyTextToClipboard.mockReset();
  copyTextToClipboard.mockResolvedValue(true);
  authenticatedFetch.mockImplementation((url: string) => {
    if (String(url).includes('/api/settings/api-keys') && !String(url).includes('/api-keys/')) {
      return jsonResponse({ apiKeys: defaultApiKeys });
    }
    if (String(url).includes('/api/settings/credentials?type=github_token')) {
      return jsonResponse({ credentials: defaultGithubCreds });
    }
    return jsonResponse({ success: true });
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCredentialsSettings', () => {
  it('fetches API keys and GitHub credentials on mount', async () => {
    render(<Harness />);
    expect(screen.getByTestId('loading')).toHaveTextContent('true');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('apiKeys')).toHaveTextContent('1');
    expect(screen.getByTestId('githubCreds')).toHaveTextContent('1');
  });

  it('handles fetch errors gracefully', async () => {
    authenticatedFetch.mockImplementation(() => Promise.reject(new Error('network down')));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(console.error).toHaveBeenCalledWith('Error fetching settings:', expect.any(Error));
  });

  it('does not create an API key with a blank name', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    const callsBefore = authenticatedFetch.mock.calls.length;
    await act(async () => {
      await controller.createApiKey();
    });
    expect(authenticatedFetch.mock.calls.length).toBe(callsBefore);
  });

  it('creates an API key successfully and refetches', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys' && opts?.method === 'POST') {
        return jsonResponse({
          success: true,
          apiKey: { id: 'k2', keyName: 'New Key', apiKey: 'sk-new' },
        });
      }
      if (String(url).includes('/api/settings/api-keys') && !String(url).includes('/api-keys/')) {
        return jsonResponse({ apiKeys: [...defaultApiKeys, { id: 'k2', key_name: 'New Key', api_key: 'sk-new', created_at: '2024-01-02', is_active: true }] });
      }
      if (String(url).includes('/api/settings/credentials?type=github_token')) {
        return jsonResponse({ credentials: defaultGithubCreds });
      }
      return jsonResponse({ success: true });
    });

    act(() => {
      controller.setNewKeyName('  New Key  ');
    });
    await act(async () => {
      await controller.createApiKey();
    });

    expect(screen.getByTestId('newlyCreatedKey')).toHaveTextContent('sk-new');
    expect(controller.showNewKeyForm).toBe(false);
    expect(controller.newKeyName).toBe('');
    await waitFor(() => expect(screen.getByTestId('apiKeys')).toHaveTextContent('2'));
  });

  it('logs an error when API key creation fails', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys' && opts?.method === 'POST') {
        return jsonResponse({ success: false, error: 'nope' }, false);
      }
      return jsonResponse({ apiKeys: defaultApiKeys });
    });

    act(() => {
      controller.setNewKeyName('Some Key');
    });
    await act(async () => {
      await controller.createApiKey();
    });
    expect(console.error).toHaveBeenCalledWith('Error creating API key:', 'nope');
  });

  it('logs default error message when creation fails without payload error', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys' && opts?.method === 'POST') {
        return jsonResponse({}, true);
      }
      return jsonResponse({ apiKeys: defaultApiKeys });
    });
    act(() => {
      controller.setNewKeyName('Some Key');
    });
    await act(async () => {
      await controller.createApiKey();
    });
    expect(console.error).toHaveBeenCalledWith('Error creating API key:', 'Failed to create API key');
  });

  it('catches thrown errors during API key creation', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys' && opts?.method === 'POST') {
        return Promise.reject(new Error('boom'));
      }
      return jsonResponse({ apiKeys: defaultApiKeys });
    });
    act(() => {
      controller.setNewKeyName('Some Key');
    });
    await act(async () => {
      await controller.createApiKey();
    });
    expect(console.error).toHaveBeenCalledWith('Error creating API key:', expect.any(Error));
  });

  it('does not delete an API key when confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    const callsBefore = authenticatedFetch.mock.calls.length;
    await act(async () => {
      await controller.deleteApiKey('k1');
    });
    expect(authenticatedFetch.mock.calls.length).toBe(callsBefore);
  });

  it('deletes an API key when confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys/k1' && opts?.method === 'DELETE') {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ apiKeys: [] });
    });
    await act(async () => {
      await controller.deleteApiKey('k1');
    });
    await waitFor(() => expect(screen.getByTestId('apiKeys')).toHaveTextContent('0'));
  });

  it('logs an error when delete API key response is not ok', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys/k1' && opts?.method === 'DELETE') {
        return jsonResponse({ error: 'cannot delete' }, false);
      }
      return jsonResponse({ apiKeys: defaultApiKeys });
    });
    await act(async () => {
      await controller.deleteApiKey('k1');
    });
    expect(console.error).toHaveBeenCalledWith('Error deleting API key:', 'cannot delete');
  });

  it('catches thrown errors during delete API key', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys/k1' && opts?.method === 'DELETE') {
        return Promise.reject(new Error('fail'));
      }
      return jsonResponse({ apiKeys: defaultApiKeys });
    });
    await act(async () => {
      await controller.deleteApiKey('k1');
    });
    expect(console.error).toHaveBeenCalledWith('Error deleting API key:', expect.any(Error));
  });

  it('toggles an API key active state and refetches', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys/k1/toggle' && opts?.method === 'PATCH') {
        expect(JSON.parse(opts.body as string)).toEqual({ isActive: false });
        return jsonResponse({ success: true });
      }
      return jsonResponse({ apiKeys: defaultApiKeys });
    });
    await act(async () => {
      await controller.toggleApiKey('k1', true);
    });
  });

  it('logs an error when toggle API key fails', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys/k1/toggle' && opts?.method === 'PATCH') {
        return jsonResponse({ error: 'toggle failed' }, false);
      }
      return jsonResponse({ apiKeys: defaultApiKeys });
    });
    await act(async () => {
      await controller.toggleApiKey('k1', true);
    });
    expect(console.error).toHaveBeenCalledWith('Error toggling API key:', 'toggle failed');
  });

  it('catches thrown errors during toggle API key', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/api-keys/k1/toggle' && opts?.method === 'PATCH') {
        return Promise.reject(new Error('boom'));
      }
      return jsonResponse({ apiKeys: defaultApiKeys });
    });
    await act(async () => {
      await controller.toggleApiKey('k1', true);
    });
    expect(console.error).toHaveBeenCalledWith('Error toggling API key:', expect.any(Error));
  });

  it('does not create a GitHub credential without name or token', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    const callsBefore = authenticatedFetch.mock.calls.length;
    await act(async () => {
      await controller.createGithubCredential();
    });
    expect(authenticatedFetch.mock.calls.length).toBe(callsBefore);

    act(() => controller.setNewGithubName('name'));
    await act(async () => {
      await controller.createGithubCredential();
    });
    expect(authenticatedFetch.mock.calls.length).toBe(callsBefore);
  });

  it('creates a GitHub credential successfully and resets form', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/credentials' && opts?.method === 'POST') {
        return jsonResponse({ success: true });
      }
      if (String(url).includes('/api/settings/credentials?type=github_token')) {
        return jsonResponse({ credentials: [...defaultGithubCreds, { id: 'g2', credential_name: 'g2', created_at: '2024-01-02', is_active: true }] });
      }
      return jsonResponse({ apiKeys: defaultApiKeys });
    });

    act(() => {
      controller.setNewGithubName('  My Cred  ');
      controller.setNewGithubToken('tok123');
      controller.setNewGithubDescription('  desc  ');
    });
    await act(async () => {
      await controller.createGithubCredential();
    });
    expect(controller.showNewGithubForm).toBe(false);
    expect(controller.newGithubName).toBe('');
    expect(controller.newGithubToken).toBe('');
    await waitFor(() => expect(screen.getByTestId('githubCreds')).toHaveTextContent('2'));
  });

  it('logs an error when GitHub credential creation fails', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/credentials' && opts?.method === 'POST') {
        return jsonResponse({ error: 'bad token' }, false);
      }
      return jsonResponse({ apiKeys: defaultApiKeys, credentials: defaultGithubCreds });
    });
    act(() => {
      controller.setNewGithubName('name');
      controller.setNewGithubToken('tok');
    });
    await act(async () => {
      await controller.createGithubCredential();
    });
    expect(console.error).toHaveBeenCalledWith('Error creating GitHub credential:', 'bad token');
  });

  it('catches thrown errors during GitHub credential creation', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/credentials' && opts?.method === 'POST') {
        return Promise.reject(new Error('down'));
      }
      return jsonResponse({ apiKeys: defaultApiKeys, credentials: defaultGithubCreds });
    });
    act(() => {
      controller.setNewGithubName('name');
      controller.setNewGithubToken('tok');
    });
    await act(async () => {
      await controller.createGithubCredential();
    });
    expect(console.error).toHaveBeenCalledWith('Error creating GitHub credential:', expect.any(Error));
  });

  it('does not delete a GitHub credential when confirm declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    const callsBefore = authenticatedFetch.mock.calls.length;
    await act(async () => {
      await controller.deleteGithubCredential('g1');
    });
    expect(authenticatedFetch.mock.calls.length).toBe(callsBefore);
  });

  it('deletes a GitHub credential when confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/credentials/g1' && opts?.method === 'DELETE') {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ credentials: [] });
    });
    await act(async () => {
      await controller.deleteGithubCredential('g1');
    });
    await waitFor(() => expect(screen.getByTestId('githubCreds')).toHaveTextContent('0'));
  });

  it('logs an error when delete GitHub credential response is not ok', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/credentials/g1' && opts?.method === 'DELETE') {
        return jsonResponse({ error: 'nope' }, false);
      }
      return jsonResponse({ credentials: defaultGithubCreds });
    });
    await act(async () => {
      await controller.deleteGithubCredential('g1');
    });
    expect(console.error).toHaveBeenCalledWith('Error deleting GitHub credential:', 'nope');
  });

  it('catches thrown errors during delete GitHub credential', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/credentials/g1' && opts?.method === 'DELETE') {
        return Promise.reject(new Error('fail'));
      }
      return jsonResponse({ credentials: defaultGithubCreds });
    });
    await act(async () => {
      await controller.deleteGithubCredential('g1');
    });
    expect(console.error).toHaveBeenCalledWith('Error deleting GitHub credential:', expect.any(Error));
  });

  it('toggles a GitHub credential active state', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/credentials/g1/toggle' && opts?.method === 'PATCH') {
        expect(JSON.parse(opts.body as string)).toEqual({ isActive: false });
        return jsonResponse({ success: true });
      }
      return jsonResponse({ credentials: defaultGithubCreds });
    });
    await act(async () => {
      await controller.toggleGithubCredential('g1', true);
    });
  });

  it('logs an error when toggling GitHub credential fails', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/credentials/g1/toggle' && opts?.method === 'PATCH') {
        return jsonResponse({ error: 'nope' }, false);
      }
      return jsonResponse({ credentials: defaultGithubCreds });
    });
    await act(async () => {
      await controller.toggleGithubCredential('g1', true);
    });
    expect(console.error).toHaveBeenCalledWith('Error toggling GitHub credential:', 'nope');
  });

  it('catches thrown errors during GitHub credential toggle', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    authenticatedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url) === '/api/settings/credentials/g1/toggle' && opts?.method === 'PATCH') {
        return Promise.reject(new Error('boom'));
      }
      return jsonResponse({ credentials: defaultGithubCreds });
    });
    await act(async () => {
      await controller.toggleGithubCredential('g1', true);
    });
    expect(console.error).toHaveBeenCalledWith('Error toggling GitHub credential:', expect.any(Error));
  });

  it('copies text to clipboard and clears the copied flag after a delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    await act(async () => {
      await controller.copyToClipboard('sk-1', 'k1');
    });
    expect(screen.getByTestId('copiedKey')).toHaveTextContent('k1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByTestId('copiedKey')).toHaveTextContent('');
  });

  it('logs an error when clipboard copy fails', async () => {
    copyTextToClipboard.mockRejectedValue(new Error('denied'));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    await act(async () => {
      await controller.copyToClipboard('sk-1', 'k1');
    });
    expect(console.error).toHaveBeenCalledWith('Failed to copy to clipboard:', expect.any(Error));
  });

  it('dismisses the newly created key', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    act(() => controller.dismissNewlyCreatedKey());
    expect(controller.newlyCreatedKey).toBeNull();
  });

  it('cancels the new API key form', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    act(() => {
      controller.setShowNewKeyForm(true);
      controller.setNewKeyName('abc');
    });
    act(() => controller.cancelNewApiKeyForm());
    expect(controller.showNewKeyForm).toBe(false);
    expect(controller.newKeyName).toBe('');
  });

  it('cancels the new GitHub form and resets token visibility', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    act(() => {
      controller.setShowNewGithubForm(true);
      controller.setNewGithubName('abc');
      controller.setNewGithubToken('tok');
      controller.setNewGithubDescription('d');
      controller.toggleNewGithubTokenVisibility();
    });
    expect(controller.showToken.new).toBe(true);
    act(() => controller.cancelNewGithubForm());
    expect(controller.showNewGithubForm).toBe(false);
    expect(controller.newGithubName).toBe('');
    expect(controller.newGithubToken).toBe('');
    expect(controller.newGithubDescription).toBe('');
    expect(controller.showToken.new).toBe(false);
  });

  it('toggles the new GitHub token visibility on', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(controller.showToken.new).toBeUndefined();
    act(() => controller.toggleNewGithubTokenVisibility());
    expect(controller.showToken.new).toBe(true);
  });
});
