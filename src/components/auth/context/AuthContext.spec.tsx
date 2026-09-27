import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ IS_PLATFORM: false, AUTH_DISABLED: false }));

vi.mock('@/constants/config', () => config);

const api = {
  auth: {
    status: vi.fn(),
    user: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  },
  user: {
    onboardingStatus: vi.fn(),
  },
};

vi.mock('@/utils/api', () => ({ api }));

const { AuthProvider, useAuth } = await import('./AuthContext');

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(auth.isLoading)}</span>
      <span data-testid="needsSetup">{String(auth.needsSetup)}</span>
      <span data-testid="user">{auth.user?.username ?? 'none'}</span>
      <span data-testid="token">{auth.token ?? 'none'}</span>
      <span data-testid="error">{auth.error ?? 'none'}</span>
      <span data-testid="onboarded">{String(auth.hasCompletedOnboarding)}</span>
      <button
        type="button"
        onClick={() => {
          void auth.login('jo', 'pw').then((result) => {
            (window as unknown as { __result?: unknown }).__result = result;
          });
        }}
      >
        login
      </button>
      <button
        type="button"
        onClick={() => {
          void auth.register('jo', 'pw').then((result) => {
            (window as unknown as { __result?: unknown }).__result = result;
          });
        }}
      >
        register
      </button>
      <button type="button" onClick={() => auth.logout()}>
        logout
      </button>
      <button type="button" onClick={() => void auth.refreshOnboardingStatus()}>
        refresh
      </button>
    </div>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    localStorage.clear();
    config.IS_PLATFORM = false;
    config.AUTH_DISABLED = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when useAuth is used outside a provider', () => {
    const BadProbe = () => {
      useAuth();
      return null;
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<BadProbe />)).toThrow('useAuth must be used within an AuthProvider');
    spy.mockRestore();
  });

  it('sets needsSetup when the server reports it and skips the user fetch', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: true }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('needsSetup')).toHaveTextContent('true');
    expect(api.auth.user).not.toHaveBeenCalled();
  });

  it('with no stored token, resolves without fetching the user', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('needsSetup')).toHaveTextContent('false');
    expect(api.auth.user).not.toHaveBeenCalled();
  });

  it('restores a session from a stored token when the server confirms it', async () => {
    localStorage.setItem('auth-token', 'stored-token');
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.user.mockResolvedValue(jsonResponse({ user: { username: 'restored' } }));
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: false }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('restored'));
    expect(screen.getByTestId('onboarded')).toHaveTextContent('false');
  });

  it('clears the session when the stored token is rejected by /auth/user', async () => {
    localStorage.setItem('auth-token', 'stale-token');
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.user.mockResolvedValue(jsonResponse({}, false));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('none'));
    expect(localStorage.getItem('auth-token')).toBeNull();
  });

  it('clears the session when /auth/user returns no user payload', async () => {
    localStorage.setItem('auth-token', 'stale-token');
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.user.mockResolvedValue(jsonResponse({}));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('token')).toHaveTextContent('none'));
  });

  it('sets an error and stops loading when the status check throws', async () => {
    api.auth.status.mockRejectedValue(new Error('network down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('error')).toHaveTextContent('Failed to check authentication status');
    spy.mockRestore();
  });

  it('logs in successfully, storing the token and clearing needsSetup', async () => {
    // NOTE (bug): checkAuthStatus depends on `token`, so setSession()'s token
    // update recreates checkAuthStatus and re-fires the mount effect, which
    // re-runs api.auth.status(). Mocking status to always report
    // needsSetup:false isolates the assertion below from that re-entrant call;
    // see the "re-checks auth status" test for the bug itself.
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.login.mockResolvedValue(
      jsonResponse({ token: 'new-token', user: { username: 'jo' } }),
    );
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: true }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await act(async () => {
      screen.getByText('login').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('jo'));
    expect(screen.getByTestId('token')).toHaveTextContent('new-token');
    expect(screen.getByTestId('needsSetup')).toHaveTextContent('false');
    expect(localStorage.getItem('auth-token')).toBe('new-token');
  });

  it('BUG: a successful login re-triggers the mount status check because ' +
    'checkAuthStatus depends on `token`, re-fetching /auth/status after login', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: true }));
    api.auth.login.mockResolvedValue(
      jsonResponse({ token: 'new-token', user: { username: 'jo' } }),
    );
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: true }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    const statusCallsBeforeLogin = api.auth.status.mock.calls.length;

    await act(async () => {
      screen.getByText('login').click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The token changed identity, so the effect re-ran and called status()
    // again -- which re-reports needsSetup:true and clobbers the just-completed
    // login's `setNeedsSetup(false)`.
    await waitFor(() =>
      expect(api.auth.status.mock.calls.length).toBeGreaterThan(statusCallsBeforeLogin),
    );
    await waitFor(() => expect(screen.getByTestId('needsSetup')).toHaveTextContent('true'));
  });

  it('surfaces the server error message on a failed login', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.login.mockResolvedValue(jsonResponse({ error: 'bad credentials' }, false));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await act(async () => {
      screen.getByText('login').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('bad credentials'));
  });

  it('sets a network error message when login throws', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.login.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await act(async () => {
      screen.getByText('login').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('Network error. Please try again.'),
    );
    spy.mockRestore();
  });

  it('registers successfully, storing the session', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: true }));
    api.auth.register.mockResolvedValue(
      jsonResponse({ token: 'reg-token', user: { username: 'newbie' } }),
    );
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: false }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await act(async () => {
      screen.getByText('register').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('newbie'));
    expect(screen.getByTestId('token')).toHaveTextContent('reg-token');
  });

  it('surfaces the fallback registration error message', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.register.mockResolvedValue(jsonResponse({}, false));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await act(async () => {
      screen.getByText('register').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('Registration failed'));
  });

  it('sets a network error message when register throws', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.register.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await act(async () => {
      screen.getByText('register').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('Network error. Please try again.'),
    );
    spy.mockRestore();
  });

  it('logs out, clearing the session and invalidating the token server-side', async () => {
    localStorage.setItem('auth-token', 'stored-token');
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.user.mockResolvedValue(jsonResponse({ user: { username: 'jo' } }));
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: true }));
    api.auth.logout.mockResolvedValue(jsonResponse({}));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('jo'));

    await act(async () => {
      screen.getByText('logout').click();
      await Promise.resolve();
    });

    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(localStorage.getItem('auth-token')).toBeNull();
    expect(api.auth.logout).toHaveBeenCalledWith('stored-token');
  });

  it('logs the error but does not throw when the logout endpoint call rejects', async () => {
    localStorage.setItem('auth-token', 'stored-token');
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.auth.user.mockResolvedValue(jsonResponse({ user: { username: 'jo' } }));
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: true }));
    api.auth.logout.mockRejectedValue(new Error('server unreachable'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('jo'));

    await act(async () => {
      screen.getByText('logout').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(spy).toHaveBeenCalledWith('Logout endpoint error:', expect.any(Error)));
    spy.mockRestore();
  });

  it('does nothing when logging out with no active token', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    act(() => {
      screen.getByText('logout').click();
    });

    expect(api.auth.logout).not.toHaveBeenCalled();
  });

  it('refreshOnboardingStatus re-fetches and updates the flag', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: false }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: true }));
    await act(async () => {
      screen.getByText('refresh').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('onboarded')).toHaveTextContent('true'));
  });

  it('fails open (treats onboarding as complete) when the status check errors', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.user.onboardingStatus.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    act(() => {
      screen.getByText('refresh').click();
    });

    await waitFor(() => expect(screen.getByTestId('onboarded')).toHaveTextContent('true'));
    spy.mockRestore();
  });

  it('does not update hasCompletedOnboarding when the response is not ok', async () => {
    api.auth.status.mockResolvedValue(jsonResponse({ needsSetup: false }));
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: false }, false));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    act(() => {
      screen.getByText('refresh').click();
    });

    await waitFor(() => expect(screen.getByTestId('onboarded')).toHaveTextContent('true'));
  });

  it('runs as the platform user without a login screen when IS_PLATFORM is set', async () => {
    config.IS_PLATFORM = true;
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: true }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('user')).toHaveTextContent('platform-user');
    expect(screen.getByTestId('needsSetup')).toHaveTextContent('false');
    expect(api.auth.status).not.toHaveBeenCalled();
  });

  it('runs as the local user with a sentinel token when AUTH_DISABLED is set', async () => {
    config.AUTH_DISABLED = true;
    api.user.onboardingStatus.mockResolvedValue(jsonResponse({ hasCompletedOnboarding: true }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('user')).toHaveTextContent('local');
    expect(screen.getByTestId('token')).toHaveTextContent('auth-disabled');
    expect(localStorage.getItem('auth-token')).toBe('auth-disabled');
    expect(api.auth.status).not.toHaveBeenCalled();
  });
});
