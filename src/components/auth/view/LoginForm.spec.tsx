import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const login = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login }),
}));

const { default: LoginForm } = await import('./LoginForm');

describe('LoginForm', () => {
  beforeEach(() => {
    login.mockReset();
  });

  it('shows a validation error and never calls login when fields are empty', async () => {
    render(<LoginForm />);

    // fireEvent.submit bypasses the browser's native `required` constraint
    // validation (which a real click on the submit button would enforce),
    // exercising the component's own validation branch directly.
    fireEvent.submit(screen.getByRole('button', { name: 'Sign In' }).closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent('Please fill in all fields');
    expect(login).not.toHaveBeenCalled();
  });

  it('submits trimmed credentials and shows the loading state', async () => {
    let resolveLogin: (value: { success: true }) => void;
    login.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText('Username'), '  jo  ');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(screen.getByRole('button', { name: 'Signing in...' })).toBeDisabled();
    expect(login).toHaveBeenCalledWith('jo', 'secret');

    resolveLogin!({ success: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign In' })).not.toBeDisabled());
  });

  it('surfaces the error returned by a failed login', async () => {
    login.mockResolvedValue({ success: false, error: 'Invalid username or password' });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText('Username'), 'jo');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
  });

  it('toggles password visibility', async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(passwordInput.type).toBe('text');

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(passwordInput.type).toBe('password');
  });
});
