import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
  apiKeys: [],
  githubCredentials: [],
  loading: false,
  showNewKeyForm: false,
  setShowNewKeyForm: vi.fn(),
  newKeyName: '',
  setNewKeyName: vi.fn(),
  showNewGithubForm: false,
  setShowNewGithubForm: vi.fn(),
  newGithubName: '',
  setNewGithubName: vi.fn(),
  newGithubToken: '',
  setNewGithubToken: vi.fn(),
  newGithubDescription: '',
  setNewGithubDescription: vi.fn(),
  showToken: {},
  copiedKey: null,
  newlyCreatedKey: null,
  createApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  toggleApiKey: vi.fn(),
  createGithubCredential: vi.fn(),
  deleteGithubCredential: vi.fn(),
  toggleGithubCredential: vi.fn(),
  copyToClipboard: vi.fn(),
  dismissNewlyCreatedKey: vi.fn(),
  cancelNewApiKeyForm: vi.fn(),
  cancelNewGithubForm: vi.fn(),
  toggleNewGithubTokenVisibility: vi.fn(),
}));

vi.mock('../../../hooks/useCredentialsSettings', () => ({
  useCredentialsSettings: () => hookState,
}));

import CredentialsSettingsTab from './CredentialsSettingsTab';

describe('CredentialsSettingsTab', () => {
  it('shows loading text when the hook reports loading', () => {
    hookState.loading = true;
    render(<CredentialsSettingsTab />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    hookState.loading = false;
  });

  it('renders API keys and GitHub sections but no new-key alert by default', () => {
    render(<CredentialsSettingsTab />);
    expect(screen.getByText('API Keys')).toBeInTheDocument();
    expect(screen.getByText('GitHub Tokens')).toBeInTheDocument();
    expect(screen.queryByText(/saved it/i)).not.toBeInTheDocument();
  });

  it('renders the new-key alert when newlyCreatedKey is set', () => {
    (hookState as { newlyCreatedKey: unknown }).newlyCreatedKey = {
      id: '1',
      keyName: 'k',
      apiKey: 'sk-abc',
    };
    render(<CredentialsSettingsTab />);
    expect(screen.getByText('sk-abc')).toBeInTheDocument();
    (hookState as { newlyCreatedKey: unknown }).newlyCreatedKey = null;
  });
});
