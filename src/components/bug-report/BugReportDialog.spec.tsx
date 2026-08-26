import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BugReportDialog from './BugReportDialog';

import type { Project, ProjectSession } from '@/types/app';


/*
 * In-app bug reporter. The dialog's job is to keep a report from being lost:
 * it blocks empty/too-short submissions, shows exactly what metadata rides
 * along, preserves the draft when durable enqueueing fails, and hands back the
 * final link when background filing succeeds.
 */

const createBugReport = vi.fn();
const getBugReportStatus = vi.fn();

vi.mock('@/utils/api', () => ({
  api: {
    createBugReport: (...args: unknown[]) => createBugReport(...args),
    getBugReportStatus: (...args: unknown[]) => getBugReportStatus(...args),
  },
}));

vi.mock('@/hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({
    currentVersion: '1.36.3',
    installMode: 'git',
    runningVersion: '1.36.3',
    restartRequired: false,
  }),
}));

const project = {
  projectId: 'p1',
  displayName: 'cloudcli',
  fullPath: '/repos/cloudcli',
} as unknown as Project;

const session = { id: 's1', provider: 'claude' } as unknown as ProjectSession;

function renderDialog(open = true, onOpenChange = vi.fn()) {
  render(
    <BugReportDialog
      open={open}
      onOpenChange={onOpenChange}
      activeTab="chat"
      selectedProject={project}
      selectedSession={session}
    />,
  );
  return onOpenChange;
}

function jsonResponse(ok: boolean, payload: unknown) {
  return { ok, json: async () => payload } as unknown as Response;
}

describe('BugReportDialog', () => {
  beforeEach(() => {
    createBugReport.mockReset();
    getBugReportStatus.mockReset();
    getBugReportStatus.mockResolvedValue(
      jsonResponse(true, {
        success: true,
        data: { status: 'filed', url: 'https://github.com/o/r/issues/9', number: 9 },
      }),
    );
  });

  it('keeps the submit action disabled until the report says something', async () => {
    renderDialog();

    const submit = screen.getByRole('button', { name: 'File issue' });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText('What happened?'), 'too short');
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText('What happened?'), ' but now it is long enough');
    expect(submit).toBeEnabled();
  });

  it('sends the description with the collected session metadata', async () => {
    createBugReport.mockResolvedValue(
      jsonResponse(true, { success: true, data: { status: 'queued', id: 'job-1' } }),
    );
    renderDialog();

    await userEvent.type(screen.getByLabelText('What happened?'), '  the tab bar scrolls itself  ');
    await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

    await waitFor(() => expect(createBugReport).toHaveBeenCalledTimes(1));
    const payload = createBugReport.mock.calls[0][0];
    expect(payload.description).toBe('the tab bar scrolls itself');
    expect(payload.metadata).toMatchObject({
      appVersion: '1.36.3',
      sessionId: 's1',
      provider: 'claude',
      projectName: 'cloudcli',
      activeTab: 'chat',
    });
  });

  it('shows the filed issue link on success', async () => {
    createBugReport.mockResolvedValue(
      jsonResponse(true, { success: true, data: { status: 'queued', id: 'job-1' } }),
    );
    renderDialog();

    await userEvent.type(screen.getByLabelText('What happened?'), 'a real and detailed report');
    await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

    const link = await screen.findByRole('link', { name: /View issue/ });
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/issues/9');
    // The form is gone, so the same report cannot be filed twice by accident.
    expect(screen.queryByRole('button', { name: 'File issue' })).toBeNull();
  });

  it('shows durable ownership while GitHub filing is still pending', async () => {
    createBugReport.mockResolvedValue(
      jsonResponse(true, { success: true, data: { status: 'queued', id: 'job-1' } }),
    );
    getBugReportStatus.mockReturnValue(new Promise(() => {}));
    renderDialog();

    await userEvent.type(screen.getByLabelText('What happened?'), 'a real and detailed report');
    await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Bug report saved');
    expect(screen.getByRole('status')).toHaveTextContent('background');
    expect(screen.queryByLabelText('What happened?')).toBeNull();
    expect(getBugReportStatus).toHaveBeenCalledWith('job-1');
  });

  it('stops presentation polling after a minute while the worker continues', async () => {
    vi.useFakeTimers();
    createBugReport.mockResolvedValue(
      jsonResponse(true, { success: true, data: { status: 'queued', id: 'job-1' } }),
    );
    getBugReportStatus.mockResolvedValue(
      jsonResponse(true, { success: true, data: { status: 'pending', id: 'job-1' } }),
    );

    try {
      renderDialog();
      fireEvent.change(screen.getByLabelText('What happened?'), {
        target: { value: 'a real and detailed report' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'File issue' }));
      await act(async () => { await Promise.resolve(); });
      for (let attempt = 1; attempt < 30; attempt += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      }

      expect(screen.getByRole('status')).toHaveTextContent('GitHub confirmation is delayed');
      expect(getBugReportStatus).toHaveBeenCalledTimes(30);
      expect(screen.queryByLabelText('What happened?')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes a terminal worker failure from an enqueue failure', async () => {
    createBugReport.mockResolvedValue(
      jsonResponse(true, { success: true, data: { status: 'queued', id: 'job-1' } }),
    );
    getBugReportStatus.mockResolvedValue(
      jsonResponse(true, {
        success: true,
        data: { status: 'failed', id: 'job-1', detail: 'unknown bug label' },
      }),
    );
    renderDialog();

    await userEvent.type(screen.getByLabelText('What happened?'), 'a real and detailed report');
    await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Bug report saved');
    expect(screen.getByRole('alert')).toHaveTextContent('unknown bug label');
    expect(screen.queryByLabelText('What happened?')).toBeNull();
  });

  it('stops after an explicit local status error', async () => {
    createBugReport.mockResolvedValue(
      jsonResponse(true, { success: true, data: { status: 'queued', id: 'job-1' } }),
    );
    getBugReportStatus.mockResolvedValue(
      jsonResponse(false, {
        success: false,
        error: { code: 'BUG_REPORT_QUEUE_UNAVAILABLE', message: 'Queue status is unavailable' },
      }),
    );
    renderDialog();

    await userEvent.type(screen.getByLabelText('What happened?'), 'a real and detailed report');
    await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Queue status is unavailable');
    expect(getBugReportStatus).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server's error message and keeps the typed report", async () => {
    createBugReport.mockResolvedValue(
      jsonResponse(false, {
        success: false,
        error: { code: 'BUG_REPORT_QUEUE_UNAVAILABLE', message: 'queue is unavailable' },
      }),
    );
    renderDialog();

    await userEvent.type(screen.getByLabelText('What happened?'), 'a real and detailed report');
    await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('queue is unavailable');
    expect(screen.getByLabelText('What happened?')).toHaveValue('a real and detailed report');
  });

  it('reports a network failure instead of failing silently', async () => {
    createBugReport.mockRejectedValue(new Error('offline'));
    renderDialog();

    await userEvent.type(screen.getByLabelText('What happened?'), 'a real and detailed report');
    await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });

  it('lets the reporter inspect the metadata before sending it', async () => {
    renderDialog();

    expect(screen.queryByText('/repos/cloudcli')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Session details attached/ }));

    expect(screen.getByText('/repos/cloudcli')).toBeInTheDocument();
    expect(screen.getByText('s1')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    renderDialog(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /*
   * Whoever opens the reporter may know something it cannot find out for itself.
   *
   * The keyboard is the case that forced this: opening the dialog means pressing
   * a button, pressing a button blurs the focused field, and on iOS that
   * dismisses the keyboard. Anything measured here is measured after the fact.
   * The press site samples first and passes the result down, so these two tests
   * pin the preference in both directions — the e2e suite proves it matters on a
   * real engine, and these prove the wiring cannot silently invert.
   */
  it('prefers the environment captured by whoever opened it', async () => {
    render(
      <BugReportDialog
        open
        onOpenChange={vi.fn()}
        activeTab="chat"
        selectedProject={project}
        selectedSession={session}
        capturedEnvironment={{
          viewport: '390×797',
          visualViewport: '390×461',
          keyboardInset: '336px',
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Session details attached/ }));

    expect(screen.getByText('336px')).toBeInTheDocument();
    expect(screen.getByText('390×461')).toBeInTheDocument();
  });

  it('falls back to reading the environment when nothing was captured', async () => {
    renderDialog();

    await userEvent.click(screen.getByRole('button', { name: /Session details attached/ }));

    // jsdom's window, but the point is only that *something* was read rather
    // than the row vanishing: a caller with no press to hang a snapshot on has
    // no keyboard to lose either.
    expect(screen.getByText(`${window.innerWidth}×${window.innerHeight}`)).toBeInTheDocument();
  });
});
