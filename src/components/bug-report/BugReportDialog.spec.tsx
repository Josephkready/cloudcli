import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BugReportDialog from './BugReportDialog';
import { MAX_ATTACHMENT_BYTES, rejectionMessage } from './attachments';

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

// jsdom ships no canvas/`createImageBitmap`, so the real client-side
// compression (dante-config skills/bug-report-button/SKILL.md §9) is
// exercised for real in `compressImage.spec.ts` and by the Playwright e2e.
// Here it's mocked to a deterministic result so these tests exercise only
// this dialog's OWN staging/paste/remove wiring around it.
const compressImageMock = vi.fn(async (file: File) => ({
  name: file.name || 'screenshot.jpg',
  mime: 'image/jpeg',
  size: 1234,
  blob: new Blob(['compressed'], { type: 'image/jpeg' }),
}));

vi.mock('./compressImage', () => ({
  compressImage: (...args: [File]) => compressImageMock(...args),
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

  it('retries a transient status-network failure and still shows the filed link', async () => {
    vi.useFakeTimers();
    createBugReport.mockResolvedValue(
      jsonResponse(true, { success: true, data: { status: 'queued', id: 'job-1' } }),
    );
    getBugReportStatus
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        jsonResponse(true, {
          success: true,
          data: { status: 'filed', url: 'https://github.com/o/r/issues/10', number: 10 },
        }),
      );

    try {
      renderDialog();
      fireEvent.change(screen.getByLabelText('What happened?'), {
        target: { value: 'a real and detailed report' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'File issue' }));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

      expect(screen.getByRole('link', { name: /View issue/ })).toHaveAttribute(
        'href', 'https://github.com/o/r/issues/10',
      );
      expect(getBugReportStatus).toHaveBeenCalledTimes(2);
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

  /*
   * Screenshots (dante-config skills/bug-report-button/SKILL.md §9). Real
   * client-side compression is covered in `compressImage.spec.ts` and the
   * Playwright e2e; these tests exercise this dialog's OWN wiring around the
   * (mocked) compressor — staging, the thumbnail/remove control, paste, and
   * the image-free path staying unaffected.
   */
  describe('screenshots', () => {
    beforeEach(() => {
      compressImageMock.mockClear();
    });

    function pngFile(name = 'shot.png') {
      return new File(['fake-png-bytes'], name, { type: 'image/png' });
    }

    it('stages a chosen file as a thumbnail and shows the privacy notice', async () => {
      renderDialog();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(screen.queryByTestId('bug-report-attachment-thumbnail')).toBeNull();

      await act(async () => {
        fireEvent.change(input, { target: { files: [pngFile()] } });
        await Promise.resolve();
      });

      expect(await screen.findByTestId('bug-report-attachment-thumbnail')).toBeInTheDocument();
      expect(screen.getByText(/Screenshots may show more of your screen/)).toBeInTheDocument();
    });

    it('the remove control drops the staged image, hides the notice, and revokes its preview', async () => {
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
      renderDialog();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      await act(async () => {
        fireEvent.change(input, { target: { files: [pngFile()] } });
        await Promise.resolve();
      });
      await screen.findByTestId('bug-report-attachment-thumbnail');

      await userEvent.click(screen.getByTestId('bug-report-attachment-remove'));

      expect(screen.queryByTestId('bug-report-attachment-thumbnail')).toBeNull();
      expect(screen.queryByText(/Screenshots may show more of your screen/)).toBeNull();
      expect(revokeSpy).toHaveBeenCalled();
    });

    it('the count cap refuses a 4th image with a visible hint, keeping the first three', async () => {
      renderDialog();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      await act(async () => {
        fireEvent.change(input, {
          target: { files: [pngFile('a.png'), pngFile('b.png'), pngFile('c.png'), pngFile('d.png')] },
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(await screen.findAllByTestId('bug-report-attachment-thumbnail')).toHaveLength(3);
      expect(screen.getByText(/Up to 3 screenshots per report/)).toBeInTheDocument();
    });

    it('rejects a source the browser cannot decode, with a visible hint', async () => {
      compressImageMock.mockRejectedValueOnce(new Error(rejectionMessage('unsupported')));
      renderDialog();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      await act(async () => {
        fireEvent.change(input, { target: { files: [pngFile('unreadable.heic')] } });
        await Promise.resolve();
      });

      expect(screen.queryByTestId('bug-report-attachment-thumbnail')).toBeNull();
      expect(await screen.findByText(/format isn.t supported/i)).toBeInTheDocument();
    });

    it('rejects a compressed blob still over the size cap, and revokes its discarded preview', async () => {
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
      compressImageMock.mockResolvedValueOnce({
        name: 'huge.png',
        mime: 'image/webp',
        size: MAX_ATTACHMENT_BYTES + 1,
        blob: new Blob(['oversized'], { type: 'image/webp' }),
      });
      renderDialog();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      await act(async () => {
        fireEvent.change(input, { target: { files: [pngFile('huge.png')] } });
        await Promise.resolve();
      });

      expect(screen.queryByTestId('bug-report-attachment-thumbnail')).toBeNull();
      expect(await screen.findByText(rejectionMessage('too-large'))).toBeInTheDocument();
      // The rejected candidate's own preview URL — created to build the
      // staging entry before the size check ran — must not leak.
      expect(revokeSpy).toHaveBeenCalled();
    });

    it('pasting an image stages it without swallowing typed text', async () => {
      renderDialog();
      const textarea = screen.getByLabelText('What happened?') as HTMLTextAreaElement;
      await userEvent.type(textarea, 'a real and detailed report');

      const clipboardData = {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => pngFile('pasted.png') }],
      };
      await act(async () => {
        fireEvent.paste(textarea, { clipboardData });
        await Promise.resolve();
      });

      expect(await screen.findByTestId('bug-report-attachment-thumbnail')).toBeInTheDocument();
      // The paste handler never calls preventDefault, so the browser's own
      // default paste behavior (which jsdom doesn't simulate) is untouched —
      // what's asserted here is that OUR handler never clears the typed text.
      expect(textarea).toHaveValue('a real and detailed report');
    });

    it('pasting text only never stages anything', async () => {
      renderDialog();
      const textarea = screen.getByLabelText('What happened?') as HTMLTextAreaElement;

      const clipboardData = { items: [{ kind: 'string', type: 'text/plain' }] };
      await act(async () => {
        fireEvent.paste(textarea, { clipboardData });
        await Promise.resolve();
      });

      expect(screen.queryByTestId('bug-report-attachment-thumbnail')).toBeNull();
      expect(compressImageMock).not.toHaveBeenCalled();
    });

    it('sends an image-free report exactly as before, with an empty attachments list', async () => {
      createBugReport.mockResolvedValue(
        jsonResponse(true, { success: true, data: { status: 'queued', id: 'job-1' } }),
      );
      renderDialog();

      await userEvent.type(screen.getByLabelText('What happened?'), 'the tab bar scrolls itself');
      await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

      await waitFor(() => expect(createBugReport).toHaveBeenCalledTimes(1));
      expect(createBugReport.mock.calls[0][0].attachments).toEqual([]);
    });

    it('sends the staged, compressed attachment alongside the report on submit', async () => {
      createBugReport.mockResolvedValue(
        jsonResponse(true, { success: true, data: { status: 'queued', id: 'job-1' } }),
      );
      renderDialog();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      await act(async () => {
        fireEvent.change(input, { target: { files: [pngFile('shot.png')] } });
        await Promise.resolve();
      });
      await screen.findByTestId('bug-report-attachment-thumbnail');

      await userEvent.type(screen.getByLabelText('What happened?'), 'see the attached screenshot');
      await userEvent.click(screen.getByRole('button', { name: 'File issue' }));

      await waitFor(() => expect(createBugReport).toHaveBeenCalledTimes(1));
      const attachments = createBugReport.mock.calls[0][0].attachments;
      expect(attachments).toHaveLength(1);
      expect(attachments[0].name).toBe('shot.png');
      expect(attachments[0].blob).toBeInstanceOf(Blob);
    });
  });
});
