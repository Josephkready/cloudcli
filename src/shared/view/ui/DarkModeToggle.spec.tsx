import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../../contexts/ThemeContext';

import DarkModeToggle from './DarkModeToggle';

describe('DarkModeToggle', () => {
  it('reflects and toggles the app-wide theme when uncontrolled', () => {
    localStorage.setItem('theme', 'light');
    render(
      <ThemeProvider>
        <DarkModeToggle />
      </ThemeProvider>,
    );

    const toggle = screen.getByRole('switch', { name: 'Toggle dark mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    localStorage.removeItem('theme');
  });

  it('operates in controlled mode, calling onToggle instead of the app-wide theme', () => {
    const onToggle = vi.fn();
    render(
      <ThemeProvider>
        <DarkModeToggle checked={false} onToggle={onToggle} ariaLabel="Custom toggle" />
      </ThemeProvider>,
    );

    const toggle = screen.getByRole('switch', { name: 'Custom toggle' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
    // Controlled: clicking does not flip aria-checked on its own since the
    // parent owns `checked` and didn't re-render with a new value.
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the checked (moon) state when controlled checked=true', () => {
    render(
      <ThemeProvider>
        <DarkModeToggle checked onToggle={vi.fn()} />
      </ThemeProvider>,
    );

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});
