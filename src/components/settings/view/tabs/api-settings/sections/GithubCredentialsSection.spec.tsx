import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { GithubCredentialItem } from '../types';

import GithubCredentialsSection from './GithubCredentialsSection';

const credentials: GithubCredentialItem[] = [
  {
    id: '1',
    credential_name: 'My Token',
    description: 'for deploys',
    created_at: '2026-01-01T00:00:00.000Z',
    is_active: true,
  },
  {
    id: '2',
    credential_name: 'Inactive Token',
    description: null,
    created_at: '2026-01-02T00:00:00.000Z',
    is_active: false,
  },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof GithubCredentialsSection>> = {}) {
  return {
    githubCredentials: [],
    showNewGithubForm: false,
    showNewTokenPlainText: false,
    newGithubName: '',
    newGithubToken: '',
    newGithubDescription: '',
    onShowNewGithubFormChange: vi.fn(),
    onNewGithubNameChange: vi.fn(),
    onNewGithubTokenChange: vi.fn(),
    onNewGithubDescriptionChange: vi.fn(),
    onToggleNewTokenVisibility: vi.fn(),
    onCreateGithubCredential: vi.fn(),
    onCancelCreateGithubCredential: vi.fn(),
    onToggleGithubCredential: vi.fn(),
    onDeleteGithubCredential: vi.fn(),
    ...overrides,
  };
}

describe('GithubCredentialsSection', () => {
  it('shows empty state with no credentials', () => {
    render(<GithubCredentialsSection {...makeProps()} />);
    expect(screen.getByText(/no github tokens/i)).toBeInTheDocument();
  });

  it('renders credential rows including description and hides it when absent', () => {
    render(<GithubCredentialsSection {...makeProps({ githubCredentials: credentials })} />);

    expect(screen.getByText('My Token')).toBeInTheDocument();
    expect(screen.getByText('for deploys')).toBeInTheDocument();
    expect(screen.getByText('Inactive Token')).toBeInTheDocument();
  });

  it('toggles the new-credential form via header button', async () => {
    const user = userEvent.setup();
    const onShowNewGithubFormChange = vi.fn();
    render(<GithubCredentialsSection {...makeProps({ onShowNewGithubFormChange })} />);

    await user.click(screen.getByRole('button', { name: /add/i }));
    expect(onShowNewGithubFormChange).toHaveBeenCalledWith(true);
  });

  it('renders the new-credential form with password-masked token by default', async () => {
    const user = userEvent.setup();
    const onNewGithubNameChange = vi.fn();
    const onNewGithubTokenChange = vi.fn();
    const onNewGithubDescriptionChange = vi.fn();
    const onToggleNewTokenVisibility = vi.fn();
    const onCreateGithubCredential = vi.fn();
    const onCancelCreateGithubCredential = vi.fn();

    render(
      <GithubCredentialsSection
        {...makeProps({
          showNewGithubForm: true,
          newGithubName: 'name',
          newGithubToken: 'tok',
          newGithubDescription: 'desc',
          onNewGithubNameChange,
          onNewGithubTokenChange,
          onNewGithubDescriptionChange,
          onToggleNewTokenVisibility,
          onCreateGithubCredential,
          onCancelCreateGithubCredential,
        })}
      />,
    );

    const tokenInput = screen.getByDisplayValue('tok') as HTMLInputElement;
    expect(tokenInput.type).toBe('password');

    await user.click(screen.getByRole('button', { name: /show token/i }));
    expect(onToggleNewTokenVisibility).toHaveBeenCalledTimes(1);

    const nameInput = screen.getByDisplayValue('name');
    await user.type(nameInput, 'x');
    expect(onNewGithubNameChange).toHaveBeenCalled();

    const descInput = screen.getByDisplayValue('desc');
    await user.type(descInput, 'y');
    expect(onNewGithubDescriptionChange).toHaveBeenCalled();

    const addButtons = screen.getAllByRole('button', { name: /add token/i });
    await user.click(addButtons[addButtons.length - 1]);
    expect(onCreateGithubCredential).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancelCreateGithubCredential).toHaveBeenCalledTimes(1);

    expect(screen.getByRole('link', { name: /how|create/i })).toHaveAttribute(
      'href',
      'https://github.com/settings/tokens',
    );
  });

  it('shows token in plain text when showNewTokenPlainText is true', () => {
    render(
      <GithubCredentialsSection
        {...makeProps({ showNewGithubForm: true, showNewTokenPlainText: true, newGithubToken: 'tok' })}
      />,
    );

    const tokenInput = screen.getByDisplayValue('tok') as HTMLInputElement;
    expect(tokenInput.type).toBe('text');
    expect(screen.getByRole('button', { name: /hide token/i })).toBeInTheDocument();
  });

  it('calls onToggleGithubCredential and onDeleteGithubCredential for a row', async () => {
    const user = userEvent.setup();
    const onToggleGithubCredential = vi.fn();
    const onDeleteGithubCredential = vi.fn();

    render(
      <GithubCredentialsSection
        {...makeProps({
          githubCredentials: [credentials[0]],
          onToggleGithubCredential,
          onDeleteGithubCredential,
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /active/i }));
    expect(onToggleGithubCredential).toHaveBeenCalledWith('1', true);

    const deleteButtons = screen.getAllByRole('button').filter((btn) => btn.querySelector('svg.lucide-trash2'));
    await user.click(deleteButtons[0]);
    expect(onDeleteGithubCredential).toHaveBeenCalledWith('1');
  });
});
