import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useFocusTrap } from '../../../shared/view/ui/useFocusTrap';
import { useOverlayDismiss } from '../../../shared/view/ui/useOverlayDismiss';

vi.mock('../../lazy/LazySurface', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
  lazySurface: () => () => <button type="button">Terminal control</button>,
}));

vi.mock('../../lazy/surfaceLoaders', () => ({
  loadStandaloneShell: vi.fn(),
}));

const { default: ProviderLoginModal } = await import('./ProviderLoginModal');

function StackedHarness() {
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [loginOpen, setLoginOpen] = useState(false);
  const { backdropProps } = useOverlayDismiss({
    isActive: settingsOpen,
    onDismiss: () => setSettingsOpen(false),
  });
  const { containerRef } = useFocusTrap<HTMLDivElement>({ isActive: settingsOpen });

  if (!settingsOpen) return <span>Settings closed</span>;

  return (
    <div data-testid="settings-backdrop" {...backdropProps}>
      <div ref={containerRef} role="dialog" aria-label="Settings">
        <button type="button" onClick={() => setLoginOpen(true)}>Open login</button>
        <button type="button">Settings control</button>
      </div>
      <ProviderLoginModal
        isOpen={loginOpen}
        onClose={() => setLoginOpen(false)}
        provider="claude"
      />
    </div>
  );
}

describe('ProviderLoginModal stacked over Settings (#279)', () => {
  it('owns focus and Escape while open, then returns control to Settings', async () => {
    const user = userEvent.setup();
    render(<StackedHarness />);

    const opener = screen.getByRole('button', { name: 'Open login' });
    await user.click(opener);

    const login = screen.getByRole('dialog', { name: 'Claude CLI Login' });
    expect(login).toHaveAttribute('aria-modal', 'true');
    expect(login).toContainElement(document.activeElement as HTMLElement);

    const close = screen.getByRole('button', { name: 'Close login modal' });
    const terminal = screen.getByRole('button', { name: 'Terminal control' });
    close.focus();
    await user.tab({ shift: true });
    expect(terminal).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Claude CLI Login' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('backdrop dismissal closes only the login layer', async () => {
    const user = userEvent.setup();
    render(<StackedHarness />);
    await user.click(screen.getByRole('button', { name: 'Open login' }));

    const login = screen.getByRole('dialog', { name: 'Claude CLI Login' });
    fireEvent.mouseDown(login.parentElement as HTMLElement);

    expect(screen.queryByRole('dialog', { name: 'Claude CLI Login' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });
});
