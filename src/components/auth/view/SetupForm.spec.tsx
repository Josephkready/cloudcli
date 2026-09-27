import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const register = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ register }),
}));

const { default: SetupForm } = await import('./SetupForm');

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  { username = '', password = '', confirmPassword = '' } = {},
) {
  if (username) await user.type(screen.getByLabelText('Username'), username);
  if (password) await user.type(screen.getByLabelText('Password'), password);
  if (confirmPassword) await user.type(screen.getByLabelText('Confirm Password'), confirmPassword);
}

describe('SetupForm', () => {
  beforeEach(() => {
    register.mockReset();
  });

  it('requires all fields to be filled', async () => {
    render(<SetupForm />);
    // fireEvent.submit bypasses native `required` constraint validation that
    // a real button click would enforce, exercising the component's own check.
    fireEvent.submit(screen.getByRole('button', { name: 'Create Account' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Please fill in all fields.');
    expect(register).not.toHaveBeenCalled();
  });

  it('rejects a too-short username', async () => {
    const user = userEvent.setup();
    render(<SetupForm />);
    await fillForm(user, { username: 'jo', password: 'secret1', confirmPassword: 'secret1' });
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Username must be at least 3 characters long.',
    );
  });

  it('rejects a too-short password', async () => {
    const user = userEvent.setup();
    render(<SetupForm />);
    await fillForm(user, { username: 'joseph', password: 'abc', confirmPassword: 'abc' });
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Password must be at least 6 characters long.',
    );
  });

  it('rejects mismatched passwords', async () => {
    const user = userEvent.setup();
    render(<SetupForm />);
    await fillForm(user, { username: 'joseph', password: 'secret1', confirmPassword: 'secret2' });
    await user.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match.');
  });

  it('registers with trimmed username on valid input', async () => {
    let resolveRegister: (value: { success: true }) => void;
    register.mockReturnValue(
      new Promise((resolve) => {
        resolveRegister = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<SetupForm />);
    await fillForm(user, { username: '  joseph  ', password: 'secret1', confirmPassword: 'secret1' });
    await user.click(screen.getByRole('button', { name: 'Create Account' }));

    expect(screen.getByRole('button', { name: 'Setting up...' })).toBeDisabled();
    expect(register).toHaveBeenCalledWith('joseph', 'secret1');

    resolveRegister!({ success: true });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create Account' })).not.toBeDisabled(),
    );
  });

  it('surfaces the error returned by a failed registration', async () => {
    register.mockResolvedValue({ success: false, error: 'Username is already taken' });
    const user = userEvent.setup();
    render(<SetupForm />);
    await fillForm(user, { username: 'joseph', password: 'secret1', confirmPassword: 'secret1' });
    await user.click(screen.getByRole('button', { name: 'Create Account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Username is already taken');
  });
});
