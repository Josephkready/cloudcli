import type { ReactNode } from 'react';
import { AUTH_DISABLED, IS_PLATFORM } from '../../../constants/config';
import { useAuth } from '../context/AuthContext';
import LazySurface, { lazySurface } from '../../lazy/LazySurface';
import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import SetupForm from './SetupForm';

// Onboarding runs once per install but sat in the entry chunk on every load,
// dragging the provider-login terminal (and therefore xterm) with it (#267).
const Onboarding = lazySurface(() => import('../../onboarding/view/Onboarding'));

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM || AUTH_DISABLED) {
    if (!hasCompletedOnboarding) {
      return (
        <LazySurface fallback={<AuthLoadingScreen />}>
          <Onboarding onComplete={refreshOnboardingStatus} />
        </LazySurface>
      );
    }

    return <>{children}</>;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return (
      <LazySurface fallback={<AuthLoadingScreen />}>
        <Onboarding onComplete={refreshOnboardingStatus} />
      </LazySurface>
    );
  }

  return <>{children}</>;
}
