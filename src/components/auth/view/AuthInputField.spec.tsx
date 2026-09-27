import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import AuthInputField from './AuthInputField';

function ControlledField(props: Partial<React.ComponentProps<typeof AuthInputField>>) {
  const [value, setValue] = useState(props.value ?? '');
  return (
    <AuthInputField
      id="username"
      label="Username"
      placeholder="Enter username"
      isDisabled={false}
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        props.onChange?.(next);
      }}
    />
  );
}

describe('AuthInputField', () => {
  it('renders a labelled text input and reports typed changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledField onChange={onChange} />);

    const input = screen.getByLabelText('Username') as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'text');
    await user.type(input, 'jo');

    expect(onChange).toHaveBeenLastCalledWith('jo');
    expect(input.value).toBe('jo');
  });

  it('defaults name to the id and forwards autoComplete', () => {
    render(<ControlledField autoComplete="username" />);
    const input = screen.getByLabelText('Username');
    expect(input).toHaveAttribute('name', 'username');
    expect(input).toHaveAttribute('autoComplete', 'username');
  });

  it('uses the provided name when supplied', () => {
    render(<ControlledField name="custom-name" />);
    expect(screen.getByLabelText('Username')).toHaveAttribute('name', 'custom-name');
  });

  it('disables the input when isDisabled is true', () => {
    render(<ControlledField isDisabled />);
    expect(screen.getByLabelText('Username')).toBeDisabled();
  });

  it('renders an icon when provided', () => {
    function Icon({ className }: { className?: string }) {
      return <svg data-testid="field-icon" className={className} />;
    }
    render(<ControlledField icon={Icon} />);
    expect(screen.getByTestId('field-icon')).toBeInTheDocument();
  });

  it('masks a password field and toggles visibility on click', async () => {
    const user = userEvent.setup();
    render(<ControlledField id="password" label="Password" type="password" value="secret" />);

    const input = screen.getByLabelText('Password') as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'password');

    const toggle = screen.getByRole('button', { name: 'Show password' });
    await user.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('disables the password visibility toggle when the field is disabled', () => {
    render(<ControlledField id="password" label="Password" type="password" isDisabled />);
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
  });
});
