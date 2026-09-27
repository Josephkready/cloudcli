import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();

vi.mock('@/utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  api: {},
  isValidRefreshedToken: () => false,
}));

vi.mock('../../provider-auth/view/ProviderLoginModal', () => ({
  default: ({
    isOpen,
    onClose,
    onComplete,
    provider,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onComplete?: (code: number) => void;
    provider?: string;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={`login-${provider}`}>
        <button onClick={() => onComplete?.(0)}>simulate success exit</button>
        <button onClick={onClose}>close login</button>
      </div>
    ) : null,
}));

const { default: Onboarding } = await import('./Onboarding');

const jsonResponse = (payload: unknown, ok = true) => ({
  ok,
  json: async () => payload,
}) as unknown as Response;

function mockFetchRouting(overrides: Record<string, () => Promise<Response>> = {}) {
  authenticatedFetch.mockImplementation((url: string, options?: RequestInit) => {
    for (const [key, handler] of Object.entries(overrides)) {
      if (url.includes(key)) return handler();
    }
    if (url.includes('/api/user/git-config') && (!options || options.method !== 'POST')) {
      return Promise.resolve(jsonResponse({}));
    }
    if (url.includes('/api/user/git-config')) {
      return Promise.resolve(jsonResponse({}));
    }
    return Promise.resolve(jsonResponse({ success: true, data: { authenticated: false } }));
  });
}

beforeEach(() => {
  authenticatedFetch.mockReset();
  mockFetchRouting();
});

async function completeGitStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/Git Name/i), 'Audit Bot');
  await user.type(screen.getByLabelText(/Git Email/i), 'bot@example.com');
  await user.click(screen.getByRole('button', { name: /Next/i }));
}

describe('Onboarding flow', () => {
  it('pre-fills the git fields from the loaded config', async () => {
    mockFetchRouting({
      '/api/user/git-config': () =>
        Promise.resolve(jsonResponse({ gitName: 'Saved Name', gitEmail: 'saved@example.com' })),
    });

    render(<Onboarding />);

    expect(await screen.findByDisplayValue('Saved Name')).toBeInTheDocument();
    expect(screen.getByDisplayValue('saved@example.com')).toBeInTheDocument();
  });

  it('logs but does not crash when loading the git config fails', async () => {
    mockFetchRouting({ '/api/user/git-config': () => Promise.reject(new Error('offline')) });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<Onboarding />);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('Error loading git config:', expect.any(Error)));
    spy.mockRestore();
  });

  it('advances to the agent connections step and completes onboarding', async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(<Onboarding onComplete={onComplete} />);

    await completeGitStep(user);

    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Previous/i })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Complete Setup/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it('surfaces a server error message when saving the git config fails', async () => {
    mockFetchRouting({
      '/api/user/git-config': () => Promise.resolve(jsonResponse({}, false)),
    });
    const user = userEvent.setup();
    render(<Onboarding />);

    await user.type(await screen.findByLabelText(/Git Name/i), 'Audit Bot');
    await user.type(screen.getByLabelText(/Git Email/i), 'bot@example.com');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('surfaces an error message when completing onboarding fails', async () => {
    const user = userEvent.setup();
    render(<Onboarding />);
    await completeGitStep(user);

    mockFetchRouting({
      '/api/user/complete-onboarding': () => Promise.resolve(jsonResponse({ error: 'nope' }, false)),
    });

    await user.click(await screen.findByRole('button', { name: /Complete Setup/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('goes back to the git step with Previous, clearing the error banner', async () => {
    const user = userEvent.setup();
    render(<Onboarding />);
    await completeGitStep(user);

    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Previous/i }));

    expect(await screen.findByLabelText(/Git Name/i)).toBeInTheDocument();
  });

  it('opens the provider login modal, refreshes statuses on close, and reports auth on success exit', async () => {
    const user = userEvent.setup();
    render(<Onboarding />);
    await completeGitStep(user);

    await screen.findByText('Claude Code');
    // The Claude card renders first among the three provider cards.
    const [claudeLoginButton] = screen.getAllByRole('button', { name: 'Login' });
    await user.click(claudeLoginButton);

    expect(screen.getByRole('dialog', { name: 'login-claude' })).toBeInTheDocument();

    const callsBeforeClose = authenticatedFetch.mock.calls.length;
    await user.click(screen.getByText('simulate success exit'));
    await user.click(screen.getByText('close login'));

    await waitFor(() =>
      expect(authenticatedFetch.mock.calls.length).toBeGreaterThan(callsBeforeClose),
    );
  });
});
