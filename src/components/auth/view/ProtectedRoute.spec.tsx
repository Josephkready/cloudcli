import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ IS_PLATFORM: false, AUTH_DISABLED: false }));
vi.mock('../../../constants/config', () => config);

const useAuth = vi.hoisted(() => vi.fn());
vi.mock('../context/AuthContext', () => ({ useAuth }));

vi.mock('../../lazy/LazySurface', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="lazy-surface">{children}</div>,
  lazySurface: () => () => <div>Onboarding surface</div>,
}));

vi.mock('./AuthLoadingScreen', () => ({
  default: () => <div>Loading auth…</div>,
}));

vi.mock('./LoginForm', () => ({
  default: () => <div>Login form</div>,
}));

vi.mock('./SetupForm', () => ({
  default: () => <div>Setup form</div>,
}));

const { default: ProtectedRoute } = await import('./ProtectedRoute');

function baseAuth(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: { username: 'jo' },
    isLoading: false,
    needsSetup: false,
    hasCompletedOnboarding: true,
    refreshOnboardingStatus: vi.fn(),
    ...overrides,
  };
}

describe('ProtectedRoute', () => {
  it('shows the loading screen while auth state is resolving', () => {
    useAuth.mockReturnValue(baseAuth({ isLoading: true }));
    render(
      <ProtectedRoute>
        <div>App</div>
      </ProtectedRoute>,
    );
    expect(screen.getByText('Loading auth…')).toBeInTheDocument();
  });

  it('shows the setup form when auth reports needsSetup', () => {
    useAuth.mockReturnValue(baseAuth({ needsSetup: true, user: null }));
    render(
      <ProtectedRoute>
        <div>App</div>
      </ProtectedRoute>,
    );
    expect(screen.getByText('Setup form')).toBeInTheDocument();
  });

  it('shows the login form when there is no user', () => {
    useAuth.mockReturnValue(baseAuth({ user: null }));
    render(
      <ProtectedRoute>
        <div>App</div>
      </ProtectedRoute>,
    );
    expect(screen.getByText('Login form')).toBeInTheDocument();
  });

  it('shows onboarding when the user is authenticated but has not completed onboarding', () => {
    useAuth.mockReturnValue(baseAuth({ hasCompletedOnboarding: false }));
    render(
      <ProtectedRoute>
        <div>App</div>
      </ProtectedRoute>,
    );
    expect(screen.getByText('Onboarding surface')).toBeInTheDocument();
  });

  it('renders children once authenticated and onboarded', () => {
    useAuth.mockReturnValue(baseAuth());
    render(
      <ProtectedRoute>
        <div>App content</div>
      </ProtectedRoute>,
    );
    expect(screen.getByText('App content')).toBeInTheDocument();
  });

  it('bypasses login/setup and shows children directly when auth is disabled and onboarded', () => {
    config.AUTH_DISABLED = true;
    useAuth.mockReturnValue(baseAuth());
    render(
      <ProtectedRoute>
        <div>App content</div>
      </ProtectedRoute>,
    );
    expect(screen.getByText('App content')).toBeInTheDocument();
    config.AUTH_DISABLED = false;
  });

  it('shows onboarding when running as the platform user without completed onboarding', () => {
    config.IS_PLATFORM = true;
    useAuth.mockReturnValue(baseAuth({ hasCompletedOnboarding: false }));
    render(
      <ProtectedRoute>
        <div>App content</div>
      </ProtectedRoute>,
    );
    expect(screen.getByText('Onboarding surface')).toBeInTheDocument();
    config.IS_PLATFORM = false;
  });
});
