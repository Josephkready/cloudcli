import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MainContentHeader from './MainContentHeader';

import type { Project, ProjectSession } from '@/types/app';

/*
 * Chat-view archive button (#215). The header owns a one-click soft-archive for
 * the open conversation: it shows only when a session is selected and it hands
 * that session's id to the shared archive handler with no confirmation step.
 */

vi.mock('@/contexts/PluginsContext', () => ({
  usePlugins: () => ({ plugins: [], loading: false, pluginsError: null, refreshPlugins: () => {} }),
}));

const project = {
  projectId: 'p1',
  projectPath: '/repos/p1',
  displayName: 'p1',
  fullPath: '/repos/p1',
  sessions: [],
} as unknown as Project;

const session = {
  id: 's1',
  summary: 'hello world',
  lastActivity: '2026-07-22T00:00:00Z',
} as unknown as ProjectSession;

function renderHeader(
  selectedSession: ProjectSession | null,
  onArchiveSession = vi.fn(),
  isMobile = false,
) {
  render(
    <MainContentHeader
      activeTab="chat"
      setActiveTab={vi.fn()}
      selectedProject={project}
      selectedSession={selectedSession}
      isMobile={isMobile}
      onMenuClick={vi.fn()}
      processingSessions={new Map()}
      onSessionSelect={vi.fn()}
      onNewSession={vi.fn()}
      onRenameSession={vi.fn()}
      onArchiveSession={onArchiveSession}
    />,
  );

  return onArchiveSession;
}

describe('MainContentHeader — archive action (#215)', () => {
  it('archives the open session on a single click, with no confirmation', async () => {
    const onArchiveSession = renderHeader(session);

    const button = screen.getByRole('button', { name: 'Archive conversation' });
    await userEvent.click(button);

    expect(onArchiveSession).toHaveBeenCalledTimes(1);
    expect(onArchiveSession).toHaveBeenCalledWith('s1');
    // A soft archive is recoverable, so nothing modal should have appeared.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides the archive action when no conversation is open', () => {
    renderHeader(null);

    expect(screen.queryByRole('button', { name: 'Archive conversation' })).toBeNull();
  });
});

/*
 * #363: the header icon buttons are 28-32px, below the repo's 44px touch floor.
 * They floor the touch height with `touch:hit-h-44` (height-only, since they sit
 * in a gap-1 row where a 44px-wide overlay would steal taps from a neighbour).
 */
describe('MainContentHeader — touch targets (#363)', () => {
  it('floors the header icon buttons at the 44px touch height', () => {
    renderHeader(session, vi.fn(), true);

    for (const name of ['Report a bug', 'Archive conversation', 'Open menu']) {
      const button = screen.getByRole('button', { name });
      expect(button.className, `"${name}" must floor its touch height`).toContain('touch:hit-h-44');
    }
  });
});

/*
 * #225: the opened-session header must surface the CLI origin. A session cloudcli
 * isn't driving (origin === 'cli') gets the same hedged badge/tooltip the sidebar
 * Conversations list uses; a cloudcli-driven (or origin-less) session stays clean,
 * so the two are no longer indistinguishable once opened.
 */
const cliSession = {
  id: 's1',
  summary: 'hello world',
  origin: 'cli',
  lastActivity: '2026-07-22T00:00:00Z',
} as unknown as ProjectSession;

const cloudSession = {
  id: 's1',
  summary: 'hello world',
  origin: 'cloudcli',
  lastActivity: '2026-07-22T00:00:00Z',
} as unknown as ProjectSession;

/*
 * The bug reporter's own behavior is covered by BugReportDialog.spec.tsx; what
 * only the header can prove is that the button is actually wired to it — and
 * that it's reachable even with no conversation open, since a bug worth filing
 * often left the app in a state where nothing else works.
 */
describe('MainContentHeader — bug reporter', () => {
  it('opens the reporter dialog from the top panel', async () => {
    renderHeader(session);

    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Report a bug' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText('What happened?')).toBeInTheDocument();
  });

  it('offers the reporter even when no conversation is open', () => {
    renderHeader(null);

    expect(screen.getByRole('button', { name: 'Report a bug' })).toBeInTheDocument();
  });

  /*
   * The press, not the open, is when the environment is worth reading — see the
   * comment on `handleReportBugPointerDown`. `userEvent.click` fires the full
   * pointer sequence, so these exercise the same ordering a tap does.
   *
   * The keyboard is driven through `--keyboard-height` — the variable the app
   * publishes and `readBrowserEnvironment` reads back — rather than through a
   * faked visual viewport, because that is now the field's actual source. What
   * these pin is *when* the read happens, which is the defect. Whether iOS
   * shrinks the viewport at all is a separate question, settled on a real engine
   * in `e2e/bug-report-capture`.
   */
  const KEYBOARD = 336;

  function publishKeyboardHeight(value: string) {
    document.documentElement.style.setProperty('--keyboard-height', value);
  }

  afterEach(() => {
    document.documentElement.style.removeProperty('--keyboard-height');
  });

  it('captures the viewport on press, before opening the dialog can disturb it', async () => {
    renderHeader(session);

    // Published while a field holds focus, and republished as zero the instant
    // the press moves focus away and the app sees the keyboard go. A reader that
    // runs at open time sees only the second value, which is the whole defect.
    publishKeyboardHeight(`${KEYBOARD}px`);
    const button = screen.getByRole('button', { name: 'Report a bug' });

    // Hung on `mousedown`, which is both where the real focus change (and so the
    // real keyboard dismissal) lands, and strictly after the `pointerdown` React
    // delegates from the root. Hanging it on `pointerdown` instead would race the
    // handler under test — a native listener on the element runs before React's
    // delegated one, so the republish would land first and the test would fail
    // against correct code.
    button.addEventListener('mousedown', () => publishKeyboardHeight('0px'));

    await userEvent.click(button);
    await userEvent.click(screen.getByRole('button', { name: /Session details attached/ }));

    // The listener republishes during the very same press, so a row reading
    // `0px` here would mean the snapshot was taken too late.
    expect(screen.getByText(`${KEYBOARD}px`)).toBeInTheDocument();
  });

  it("does not let a keyboard-opened report inherit an earlier tap's viewport", async () => {
    renderHeader(session);

    // First open is a real tap, taken while a keyboard height is published.
    publishKeyboardHeight(`${KEYBOARD}px`);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close bug report' }));
    publishKeyboardHeight('0px');

    // Second open is a bare `click` with no preceding `pointerdown` — what
    // activating the button from the keyboard produces. Nothing was pressed, so
    // there is no fresh snapshot, and without the reset this would reuse the
    // stale one above and report a keyboard that is not there.
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    await userEvent.click(screen.getByRole('button', { name: /Session details attached/ }));

    expect(screen.getByText('0px')).toBeInTheDocument();
    expect(screen.queryByText(`${KEYBOARD}px`)).toBeNull();
  });
});

describe('MainContentHeader — CLI-origin badge (#225)', () => {
  it('badges the open-session title when the session is terminal/CLI-driven', () => {
    renderHeader(cliSession);

    const badge = screen.getByLabelText('Session not driven by cloudcli');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('CLI');
    expect(badge).toHaveAttribute(
      'title',
      'Not driven by cloudcli — started from a terminal/CLI (or created before session tracking), so its live status is unknown',
    );
  });

  it('shows no CLI badge for a cloudcli-driven session', () => {
    renderHeader(cloudSession);

    expect(screen.queryByLabelText('Session not driven by cloudcli')).toBeNull();
  });

  it('shows no CLI badge when no conversation is open', () => {
    renderHeader(null);

    expect(screen.queryByLabelText('Session not driven by cloudcli')).toBeNull();
  });
});
