import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();

vi.mock('@/utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  api: {},
  isValidRefreshedToken: () => false,
}));

// Imported after the mock so the component picks up the stubbed fetch.
const { default: Onboarding } = await import('./Onboarding');

/*
 * #236: a malformed git email left "Next" disabled with no explanation. Because
 * the button was disabled by the same predicate that guards handleNextStep, the
 * validation copy in that handler could never render — it was dead code. Next
 * now stays enabled (matching the project-creation wizard) so the message shows.
 */

const jsonResponse = (payload: unknown) => ({
  ok: true,
  json: async () => payload,
}) as unknown as Response;

beforeEach(() => {
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/user/git-config')) {
      return Promise.resolve(jsonResponse({}));
    }
    return Promise.resolve(jsonResponse({ success: true, data: { authenticated: false } }));
  });
});

const gitConfigWrites = () => authenticatedFetch.mock.calls.filter(
  ([url, options]) => String(url).includes('/api/user/git-config')
    && (options as { method?: string } | undefined)?.method === 'POST',
);

describe('Onboarding — git email validation (#236)', () => {
  it('keeps Next enabled and explains why an invalid email is rejected', async () => {
    const user = userEvent.setup();
    render(<Onboarding />);

    await user.type(await screen.findByLabelText(/Git Name/i), 'Audit Bot');
    await user.type(screen.getByLabelText(/Git Email/i), 'not-an-email');

    const next = screen.getByRole('button', { name: /Next/i });
    expect(next).toBeEnabled();

    await user.click(next);

    expect(await screen.findByRole('alert')).toHaveTextContent('Please enter a valid email address.');
    // The invalid value must never reach the server.
    expect(gitConfigWrites()).toHaveLength(0);
  });

  it('explains an empty form instead of silently disabling Next', async () => {
    const user = userEvent.setup();
    render(<Onboarding />);

    const next = await screen.findByRole('button', { name: /Next/i });
    expect(next).toBeEnabled();

    await user.click(next);

    expect(await screen.findByRole('alert')).toHaveTextContent('Both git name and email are required.');
    expect(gitConfigWrites()).toHaveLength(0);
  });

  it('clears the message as soon as the user corrects the field', async () => {
    const user = userEvent.setup();
    render(<Onboarding />);

    await user.type(await screen.findByLabelText(/Git Name/i), 'Audit Bot');
    const email = screen.getByLabelText(/Git Email/i);
    await user.type(email, 'not-an-email');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.type(email, '@example.com');

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

vi.mock('../../lazy/LazySurface', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
  lazySurface: () => () => <button type="button">Terminal control</button>,
}));

vi.mock('../../lazy/surfaceLoaders', () => ({
  loadStandaloneShell: vi.fn(),
}));

describe('Onboarding — step navigation and completion', () => {
  it('prefills git name/email from the server and advances to the agent step on submit', async () => {
    const user = userEvent.setup();
    authenticatedFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/user/git-config')) {
        if (options?.method === 'POST') {
          return Promise.resolve(jsonResponse({}));
        }
        return Promise.resolve(jsonResponse({ gitName: 'Existing Name', gitEmail: 'existing@example.com' }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: { authenticated: false } }));
    });

    render(<Onboarding />);

    expect(await screen.findByLabelText(/Git Name/i)).toHaveValue('Existing Name');
    expect(screen.getByLabelText(/Git Email/i)).toHaveValue('existing@example.com');

    await user.click(screen.getByRole('button', { name: /Next/i }));

    expect(await screen.findByText('Connect Your AI Agents')).toBeInTheDocument();
    expect(gitConfigWrites()).toHaveLength(1);
    expect(gitConfigWrites()[0][1]).toMatchObject({
      body: JSON.stringify({ gitName: 'Existing Name', gitEmail: 'existing@example.com' }),
    });
  });

  it('surfaces the server error message when saving the git config fails', async () => {
    const user = userEvent.setup();
    authenticatedFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/user/git-config')) {
        if (options?.method === 'POST') {
          return Promise.resolve({ ok: false, json: async () => ({ error: 'git config rejected' }) } as Response);
        }
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({ success: true, data: { authenticated: false } }));
    });

    render(<Onboarding />);

    await user.type(await screen.findByLabelText(/Git Name/i), 'Audit Bot');
    await user.type(screen.getByLabelText(/Git Email/i), 'audit@example.com');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('git config rejected');
  });

  it('opens the provider login modal from the agent connections step and closes it', async () => {
    const user = userEvent.setup();
    render(<Onboarding />);

    await user.type(await screen.findByLabelText(/Git Name/i), 'Audit Bot');
    await user.type(screen.getByLabelText(/Git Email/i), 'audit@example.com');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    await screen.findByText('Connect Your AI Agents');
    authenticatedFetch.mockClear();

    const loginButtons = await screen.findAllByRole('button', { name: 'Login' });
    await user.click(loginButtons[0]);

    expect(screen.getByRole('dialog', { name: 'Claude CLI Login' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close login modal' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Closing the modal re-checks every provider's auth status (#onboarding refresh).
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
  });

  it('navigates back from the agent connections step to git configuration', async () => {
    const user = userEvent.setup();
    render(<Onboarding />);

    await user.type(await screen.findByLabelText(/Git Name/i), 'Audit Bot');
    await user.type(screen.getByLabelText(/Git Email/i), 'audit@example.com');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    await screen.findByText('Connect Your AI Agents');
    await user.click(screen.getByRole('button', { name: /Previous/i }));

    expect(await screen.findByLabelText(/Git Name/i)).toBeInTheDocument();
  });

  it('completes onboarding and invokes onComplete on success', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<Onboarding onComplete={onComplete} />);

    await user.type(await screen.findByLabelText(/Git Name/i), 'Audit Bot');
    await user.type(screen.getByLabelText(/Git Email/i), 'audit@example.com');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    await screen.findByText('Connect Your AI Agents');
    await user.click(screen.getByRole('button', { name: /Complete Setup/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(
      authenticatedFetch.mock.calls.some(([url, options]) => (
        String(url).includes('/api/user/complete-onboarding') && (options as { method?: string }).method === 'POST'
      )),
    ).toBe(true);
  });

  it('shows an error and does not call onComplete when completion fails', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    authenticatedFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/user/complete-onboarding')) {
        return Promise.resolve({ ok: false, json: async () => ({ error: 'boom' }) } as Response);
      }
      if (typeof url === 'string' && url.includes('/api/user/git-config')) {
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({ success: true, data: { authenticated: false } }));
    });

    render(<Onboarding onComplete={onComplete} />);

    await user.type(await screen.findByLabelText(/Git Name/i), 'Audit Bot');
    await user.type(screen.getByLabelText(/Git Email/i), 'audit@example.com');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    await screen.findByText('Connect Your AI Agents');
    await user.click(screen.getByRole('button', { name: /Complete Setup/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(onComplete).not.toHaveBeenCalled();
  });
});
