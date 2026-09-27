import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import GithubAuthenticationCard from './GithubAuthenticationCard';
import type { GithubTokenCredential, TokenMode } from '../types';

const TOKENS: GithubTokenCredential[] = [
  { id: 1, credential_name: 'work-token', is_active: true },
  { id: 2, credential_name: 'personal-token', is_active: true },
];

function renderCard(overrides: Partial<Parameters<typeof GithubAuthenticationCard>[0]> = {}) {
  const onTokenModeChange = vi.fn();
  const onSelectedGithubTokenChange = vi.fn();
  const onNewGithubTokenChange = vi.fn();

  const props = {
    tokenMode: 'stored' as TokenMode,
    selectedGithubToken: '',
    newGithubToken: '',
    availableTokens: TOKENS,
    loadingTokens: false,
    tokenLoadError: null as string | null,
    onTokenModeChange,
    onSelectedGithubTokenChange,
    onNewGithubTokenChange,
    ...overrides,
  };

  const result = render(<GithubAuthenticationCard {...props} />);
  return { ...result, onTokenModeChange, onSelectedGithubTokenChange, onNewGithubTokenChange };
}

describe('GithubAuthenticationCard', () => {
  it('shows a loading indicator while tokens are loading, hiding the mode switch', () => {
    renderCard({ loadingTokens: true });

    expect(screen.getByText('Loading stored tokens...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stored Token' })).toBeNull();
  });

  it('surfaces a load error once loading finishes', () => {
    renderCard({ loadingTokens: false, tokenLoadError: 'Failed to load GitHub tokens' });

    expect(screen.getByText('Failed to load GitHub tokens')).toBeInTheDocument();
  });

  it('lists stored tokens in the select when tokenMode is stored', () => {
    renderCard({ tokenMode: 'stored' });

    expect(screen.getByText('Select Token')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'work-token' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'personal-token' })).toBeInTheDocument();
  });

  it('calls onSelectedGithubTokenChange when a stored token is picked', async () => {
    const user = userEvent.setup();
    const { onSelectedGithubTokenChange } = renderCard({ tokenMode: 'stored' });

    await user.selectOptions(screen.getByRole('combobox'), '2');

    expect(onSelectedGithubTokenChange).toHaveBeenCalledWith('2');
  });

  it('shows a password input for a new token when tokenMode is new', () => {
    renderCard({ tokenMode: 'new' });

    expect(screen.getByPlaceholderText(/ghp_x+/)).toBeInTheDocument();
  });

  it('calls onNewGithubTokenChange as the new token is typed', async () => {
    const user = userEvent.setup();
    const { onNewGithubTokenChange } = renderCard({ tokenMode: 'new' });

    await user.type(screen.getByPlaceholderText(/ghp_x+/), 'a');

    expect(onNewGithubTokenChange).toHaveBeenCalledWith('a');
  });

  it('switches to "stored" mode when that button is clicked', async () => {
    const user = userEvent.setup();
    const { onTokenModeChange } = renderCard({ tokenMode: 'new' });

    await user.click(screen.getByRole('button', { name: 'Stored Token' }));

    expect(onTokenModeChange).toHaveBeenCalledWith('stored');
  });

  it('switches to "new" mode when that button is clicked', async () => {
    const user = userEvent.setup();
    const { onTokenModeChange } = renderCard({ tokenMode: 'stored' });

    await user.click(screen.getByRole('button', { name: 'New Token' }));

    expect(onTokenModeChange).toHaveBeenCalledWith('new');
  });

  it('clears the selected and new token fields when "None (Public)" is chosen', async () => {
    const user = userEvent.setup();
    const { onTokenModeChange, onSelectedGithubTokenChange, onNewGithubTokenChange } = renderCard({
      tokenMode: 'stored',
    });

    await user.click(screen.getByRole('button', { name: 'None (Public)' }));

    expect(onTokenModeChange).toHaveBeenCalledWith('none');
    expect(onSelectedGithubTokenChange).toHaveBeenCalledWith('');
    expect(onNewGithubTokenChange).toHaveBeenCalledWith('');
  });

  it('renders neither select nor password input when tokenMode is none', () => {
    renderCard({ tokenMode: 'none' });

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByPlaceholderText(/ghp_x+/)).toBeNull();
  });

  it('offers a single optional token field when there are no stored tokens', () => {
    renderCard({ availableTokens: [], tokenMode: 'none' });

    expect(screen.getByText(/Public repositories don't require authentication/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/leave empty for public repos/)).toBeInTheDocument();
  });

  it('switches to "new" mode automatically once a value is typed with no stored tokens', async () => {
    const user = userEvent.setup();
    const { onTokenModeChange, onNewGithubTokenChange } = renderCard({
      availableTokens: [],
      tokenMode: 'none',
    });

    await user.type(screen.getByPlaceholderText(/leave empty for public repos/), 'x');

    expect(onNewGithubTokenChange).toHaveBeenCalledWith('x');
    expect(onTokenModeChange).toHaveBeenCalledWith('new');
  });

  it('switches back to "none" once the no-stored-tokens field is cleared', async () => {
    const { onTokenModeChange } = renderCard({
      availableTokens: [],
      tokenMode: 'new',
      newGithubToken: 'x',
    });

    const input = screen.getByPlaceholderText(/leave empty for public repos/);
    // Simulate clearing the field down to empty via fireEvent-equivalent typing removal.
    await userEvent.setup().clear(input);

    expect(onTokenModeChange).toHaveBeenCalledWith('none');
  });
});
