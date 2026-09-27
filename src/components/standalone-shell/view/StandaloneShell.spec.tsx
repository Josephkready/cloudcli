import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';

/*
 * `StandaloneShell` is the surface `ProviderLoginModal` embeds to run
 * provider CLI logins (Claude/Codex/Antigravity) — it decides plain-shell vs.
 * session mode, whether to show its own header, and forces `autoConnect` on
 * in `minimal` mode. The real `Shell` is covered by its own spec, so it is
 * stubbed here to isolate that decision logic and prop wiring.
 */

const shellProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('../../shell/view/Shell', () => ({
  default: (props: Record<string, unknown>) => {
    shellProps.last = props;
    return <div data-testid="shell-stub">shell</div>;
  },
}));

const { default: StandaloneShell } = await import('./StandaloneShell');

const PROJECT: Project = {
  projectId: '/tmp/project',
  displayName: 'project',
  fullPath: '/tmp/project',
  path: '/tmp/project',
};

const SESSION: ProjectSession = { id: 'sess-1' } as ProjectSession;

beforeEach(() => {
  shellProps.last = null;
});

describe('StandaloneShell — no project', () => {
  it('renders the empty state and never mounts Shell', () => {
    render(<StandaloneShell project={null} className="my-class" />);

    expect(screen.getByText('No Project Selected')).toBeInTheDocument();
    expect(screen.queryByTestId('shell-stub')).not.toBeInTheDocument();
  });
});

describe('StandaloneShell — plain-shell derivation', () => {
  it('infers plain shell mode from a command when isPlainShell is not given', () => {
    render(<StandaloneShell project={PROJECT} command="claude auth login" />);

    expect(shellProps.last?.isPlainShell).toBe(true);
    expect(shellProps.last?.initialCommand).toBe('claude auth login');
  });

  it('is not a plain shell without a command or explicit flag', () => {
    render(<StandaloneShell project={PROJECT} />);

    expect(shellProps.last?.isPlainShell).toBe(false);
  });

  it('lets an explicit isPlainShell flag override command inference', () => {
    render(<StandaloneShell project={PROJECT} command="claude auth login" isPlainShell={false} />);

    expect(shellProps.last?.isPlainShell).toBe(false);
  });
});

describe('StandaloneShell — header', () => {
  it('shows the header with a title and forwards close', () => {
    const onClose = vi.fn();
    render(
      <StandaloneShell project={PROJECT} title="Claude Login" onClose={onClose} />,
    );

    expect(screen.getByText('Claude Login')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the header when showHeader is false', () => {
    render(<StandaloneShell project={PROJECT} title="Claude Login" showHeader={false} />);

    expect(screen.queryByText('Claude Login')).not.toBeInTheDocument();
  });

  it('hides the header when minimal, even with a title and showHeader', () => {
    render(<StandaloneShell project={PROJECT} title="Claude Login" minimal />);

    expect(screen.queryByText('Claude Login')).not.toBeInTheDocument();
  });

  it('hides the header when no title is given', () => {
    render(<StandaloneShell project={PROJECT} showHeader />);

    expect(screen.queryByTitle('Close')).not.toBeInTheDocument();
  });

  it('marks the session completed once the process finishes', () => {
    const onComplete = vi.fn();
    render(<StandaloneShell project={PROJECT} title="Claude Login" onComplete={onComplete} />);

    (shellProps.last?.onProcessComplete as (code: number) => void)(0);

    expect(onComplete).toHaveBeenCalledWith(0);
  });
});

describe('StandaloneShell — minimal mode forces autoConnect', () => {
  it('always passes autoConnect true to Shell in minimal mode, regardless of the prop', () => {
    render(<StandaloneShell project={PROJECT} minimal autoConnect={false} />);

    expect(shellProps.last?.autoConnect).toBe(true);
    expect(shellProps.last?.minimal).toBe(true);
  });

  it('forwards the autoConnect prop as-is outside of minimal mode', () => {
    render(<StandaloneShell project={PROJECT} autoConnect={false} />);

    expect(shellProps.last?.autoConnect).toBe(false);
  });
});

describe('StandaloneShell — session and project pass-through', () => {
  it('forwards project, session and isActive to Shell', () => {
    render(<StandaloneShell project={PROJECT} session={SESSION} isActive={false} />);

    expect(shellProps.last?.selectedProject).toBe(PROJECT);
    expect(shellProps.last?.selectedSession).toBe(SESSION);
    expect(shellProps.last?.isActive).toBe(false);
  });
});
