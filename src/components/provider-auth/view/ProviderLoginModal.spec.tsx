import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useFocusTrap } from '../../../shared/view/ui/useFocusTrap';
import { useOverlayDismiss } from '../../../shared/view/ui/useOverlayDismiss';

const config = vi.hoisted(() => ({
  IS_PLATFORM: false,
  DEFAULT_PROJECT_FOR_EMPTY_SHELL: { id: 'empty', name: '', fullPath: '', path: '' },
}));
vi.mock('../../../constants/config', () => config);

const capturedShellProps = vi.hoisted(() => ({ current: null as null | { command?: string; onComplete?: (code: number) => void } }));

vi.mock('../../lazy/LazySurface', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
  lazySurface: () => (props: { command?: string; onComplete?: (code: number) => void }) => {
    capturedShellProps.current = props;
    return (
      <button type="button" onClick={() => props.onComplete?.(0)}>
        Terminal control
      </button>
    );
  },
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

describe('ProviderLoginModal command and title resolution', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <ProviderLoginModal isOpen={false} onClose={vi.fn()} provider="claude" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('uses the codex login command and title when not running as the platform', () => {
    config.IS_PLATFORM = false;
    render(<ProviderLoginModal isOpen onClose={vi.fn()} provider="codex" />);
    expect(screen.getByRole('dialog', { name: 'Codex CLI Login' })).toBeInTheDocument();
    expect(capturedShellProps.current?.command).toBe('codex login');
  });

  it('uses the codex device-auth command when running as the platform', () => {
    config.IS_PLATFORM = true;
    render(<ProviderLoginModal isOpen onClose={vi.fn()} provider="codex" />);
    expect(capturedShellProps.current?.command).toBe('codex login --device-auth');
    config.IS_PLATFORM = false;
  });

  it('uses the antigravity command and title', () => {
    render(<ProviderLoginModal isOpen onClose={vi.fn()} provider="antigravity" />);
    expect(screen.getByRole('dialog', { name: 'Antigravity CLI Login' })).toBeInTheDocument();
    expect(capturedShellProps.current?.command).toBe('agy');
  });

  it('uses a custom command when provided, overriding the provider default', () => {
    render(
      <ProviderLoginModal isOpen onClose={vi.fn()} provider="claude" customCommand="claude login --custom" />,
    );
    expect(capturedShellProps.current?.command).toBe('claude login --custom');
  });

  it('calls onComplete with the exit code but keeps the modal open', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<ProviderLoginModal isOpen onClose={vi.fn()} provider="claude" onComplete={onComplete} />);

    await user.click(screen.getByRole('button', { name: 'Terminal control' }));

    expect(onComplete).toHaveBeenCalledWith(0);
    expect(screen.getByRole('dialog', { name: 'Claude CLI Login' })).toBeInTheDocument();
  });

  it('does not throw when the terminal completes without an onComplete handler', async () => {
    const user = userEvent.setup();
    render(<ProviderLoginModal isOpen onClose={vi.fn()} provider="claude" />);
    await user.click(screen.getByRole('button', { name: 'Terminal control' }));
    expect(screen.getByRole('dialog', { name: 'Claude CLI Login' })).toBeInTheDocument();
  });

  it('closes the modal when the close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProviderLoginModal isOpen onClose={onClose} provider="claude" />);
    await user.click(screen.getByRole('button', { name: 'Close login modal' }));
    expect(onClose).toHaveBeenCalled();
  });
});
