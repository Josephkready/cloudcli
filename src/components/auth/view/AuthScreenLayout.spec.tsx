import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AuthScreenLayout from './AuthScreenLayout';

describe('AuthScreenLayout', () => {
  it('renders title, description, children and footer text', () => {
    render(
      <AuthScreenLayout title="Welcome back" description="Sign in to continue" footerText="v1.0.0">
        <div>form content</div>
      </AuthScreenLayout>,
    );

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByText('Sign in to continue')).toBeInTheDocument();
    expect(screen.getByText('form content')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    // Default logo image renders when no custom logo is supplied.
    expect(screen.getByAltText('CloudCLI')).toBeInTheDocument();
  });

  it('renders a custom logo instead of the default one when provided', () => {
    render(
      <AuthScreenLayout
        title="Welcome"
        description="desc"
        footerText="footer"
        logo={<span data-testid="custom-logo">Custom</span>}
      >
        <div>content</div>
      </AuthScreenLayout>,
    );

    expect(screen.getByTestId('custom-logo')).toBeInTheDocument();
    expect(screen.queryByAltText('CloudCLI')).not.toBeInTheDocument();
  });
});
