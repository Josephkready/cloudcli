import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ IS_PLATFORM: false }));
vi.mock('@/constants/config', () => ({
  get IS_PLATFORM() {
    return config.IS_PLATFORM;
  },
  DEFAULT_PROJECT_FOR_EMPTY_SHELL: { fullPath: '', path: '' },
}));

let lastShellProps: Record<string, unknown> = {};

vi.mock('../../lazy/LazySurface', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
  lazySurface: (loader: () => Promise<unknown>) => {
    void loader;
    return function StandaloneShellStub(props: Record<string, unknown>) {
      lastShellProps = props;
      return <div>Terminal: {String(props.command)}</div>;
    };
  },
}));

vi.mock('../../lazy/surfaceLoaders', () => ({
  loadStandaloneShell: vi.fn(),
}));

const { default: ProviderLoginModal } = await import('./ProviderLoginModal');

describe('ProviderLoginModal provider/command branches', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <ProviderLoginModal isOpen={false} onClose={() => {}} provider="claude" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('uses a custom command over the provider default when supplied', () => {
    render(
      <ProviderLoginModal isOpen onClose={() => {}} provider="claude" customCommand="echo hi" />,
    );
    expect(screen.getByText('Terminal: echo hi')).toBeInTheDocument();
  });

  it('uses the codex login command and title (non-platform)', () => {
    config.IS_PLATFORM = false;
    render(<ProviderLoginModal isOpen onClose={() => {}} provider="codex" />);
    expect(screen.getByRole('dialog', { name: 'Codex CLI Login' })).toBeInTheDocument();
    expect(screen.getByText('Terminal: codex login')).toBeInTheDocument();
  });

  it('uses the device-auth codex command under IS_PLATFORM', () => {
    config.IS_PLATFORM = true;
    render(<ProviderLoginModal isOpen onClose={() => {}} provider="codex" />);
    expect(screen.getByText('Terminal: codex login --device-auth')).toBeInTheDocument();
    config.IS_PLATFORM = false;
  });

  it('uses the antigravity command and title', () => {
    render(<ProviderLoginModal isOpen onClose={() => {}} provider="antigravity" />);
    expect(screen.getByRole('dialog', { name: 'Antigravity CLI Login' })).toBeInTheDocument();
    expect(screen.getByText('Terminal: agy')).toBeInTheDocument();
  });

  it('calls onComplete but keeps the modal open when the terminal exits', () => {
    const onComplete = vi.fn();
    render(<ProviderLoginModal isOpen onClose={() => {}} provider="claude" onComplete={onComplete} />);

    (lastShellProps.onComplete as (code: number) => void)(0);

    expect(onComplete).toHaveBeenCalledWith(0);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not throw when the terminal exits and no onComplete was provided', () => {
    render(<ProviderLoginModal isOpen onClose={() => {}} provider="claude" />);
    expect(() => (lastShellProps.onComplete as (code: number) => void)(1)).not.toThrow();
  });

  it('invokes onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ProviderLoginModal isOpen onClose={onClose} provider="claude" />);

    await user.click(screen.getByRole('button', { name: 'Close login modal' }));
    expect(onClose).toHaveBeenCalled();
  });
});
