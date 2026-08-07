import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BugReportDialog from './BugReportDialog';

import type { Project, ProjectSession } from '@/types/app';


/*
 * In-app bug reporter. The dialog's job is to keep a report from being lost:
 * it blocks empty/too-short submissions, shows exactly what metadata rides
 * along, surfaces the server's own error text when filing fails, and hands
 * back a link when it succeeds.
 */

const createBugReport = vi.fn();

vi.mock('@/utils/api', () => ({
  api: {
    createBugReport: (...args: unknown[]) => createBugReport(...args),
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
      jsonResponse(true, { success: true, data: { issueUrl: 'https://github.com/o/r/issues/9' } }),
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
      jsonResponse(true, { success: true, data: { issueUrl: 'https://github.com/o/r/issues/9' } }),
    );
    renderDialog();

    await userEvent.type(screen.getByLabelText('What happened?'), 'a real and detailed report');
    await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

    const link = await screen.findByRole('link', { name: /View issue/ });
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/issues/9');
    // The form is gone, so the same report cannot be filed twice by accident.
    expect(screen.queryByRole('button', { name: 'File issue' })).toBeNull();
  });

  it("surfaces the server's error message and keeps the typed report", async () => {
    createBugReport.mockResolvedValue(
      jsonResponse(false, {
        success: false,
        error: { code: 'BUG_REPORT_GH_UNAUTHENTICATED', message: 'gh is not authenticated' },
      }),
    );
    renderDialog();

    await userEvent.type(screen.getByLabelText('What happened?'), 'a real and detailed report');
    await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('gh is not authenticated');
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
});
