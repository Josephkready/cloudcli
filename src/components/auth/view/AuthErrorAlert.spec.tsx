import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AuthErrorAlert from './AuthErrorAlert';

describe('AuthErrorAlert', () => {
  it('renders nothing when there is no error message', () => {
    const { container } = render(<AuthErrorAlert errorMessage="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the error message inside an alert role when present', () => {
    render(<AuthErrorAlert errorMessage="Invalid credentials" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials');
  });
});
