import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AuthLoadingScreen from './AuthLoadingScreen';

describe('AuthLoadingScreen', () => {
  it('renders an accessible loading status', () => {
    render(<AuthLoadingScreen />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading authentication state');
    expect(screen.getByAltText('CloudCLI')).toBeInTheDocument();
  });
});
