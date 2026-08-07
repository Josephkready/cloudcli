import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ProjectCreationWizard from './ProjectCreationWizard';

/*
 * #237: the wizard cleared `error` in handleNext/handleBack/handleCreate but
 * never on field change, so the red "Please provide a workspace path" banner
 * stayed on screen above a now-populated field — the message told the user to
 * do the thing they had just done.
 */

const PATH_ERROR = 'Please provide a workspace path';

function renderWizard() {
  const onClose = vi.fn();
  const result = render(<ProjectCreationWizard onClose={onClose} />);
  return { ...result, onClose };
}

async function triggerPathError(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /next/i }));
  expect(await screen.findByText(PATH_ERROR)).toBeInTheDocument();
}

describe('ProjectCreationWizard — validation banner lifecycle (#237)', () => {
  it('still raises the banner when Next is pressed with an empty path', async () => {
    const user = userEvent.setup();
    renderWizard();

    await triggerPathError(user);
  });

  it('clears the banner as soon as the user types a path', async () => {
    const user = userEvent.setup();
    renderWizard();

    await triggerPathError(user);

    await user.type(screen.getByPlaceholderText('/path/to/project/workspace'), '/tmp/demo-app');

    await waitFor(() => expect(screen.queryByText(PATH_ERROR)).toBeNull());
  });

  it('clears the banner when any other wizard field is edited', async () => {
    const user = userEvent.setup();
    renderWizard();

    await triggerPathError(user);

    // The GitHub URL field routes through the same updateField callback as the
    // folder-picker selection does, so covering it covers that path too.
    const githubUrl = screen.getByPlaceholderText(/github\.com/i);
    await user.type(githubUrl, 'https://github.com/acme/demo.git');

    await waitFor(() => expect(screen.queryByText(PATH_ERROR)).toBeNull());
  });
});

/*
 * #243: the wizard is a hand-rolled `fixed inset-0` overlay with no keydown
 * handler, so Esc and backdrop clicks did nothing — while /help, /status and
 * Token Usage all close on Esc.
 */
describe('ProjectCreationWizard — Esc and backdrop dismissal (#243)', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWizard();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click on the backdrop but not inside the dialog', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWizard();

    const dialog = screen.getByRole('dialog', { name: /create new project/i });
    await user.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    await user.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes only the folder picker while it is stacked on top', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWizard();

    await user.click(screen.getByRole('button', { name: 'Browse folders' }));
    expect(await screen.findByRole('dialog', { name: 'Select Folder' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    // The picker is gone, the wizard survives.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Select Folder' })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /create new project/i })).toBeInTheDocument();

    // A second Escape then closes the wizard.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/*
 * #274: the wizard covers the whole screen but never trapped focus, so Tab
 * walked out of it into the app behind. The picker stacks on top of the wizard,
 * so the trap has to follow the topmost overlay exactly like Esc does.
 */
describe('ProjectCreationWizard — focus trap (#274)', () => {
  function renderWizardOverPage() {
    const onClose = vi.fn();
    const result = render(
      <>
        <button type="button">behind the wizard</button>
        <ProjectCreationWizard onClose={onClose} />
      </>,
    );
    return { ...result, onClose };
  }

  it('moves focus into the wizard when it opens', () => {
    renderWizardOverPage();

    const dialog = screen.getByRole('dialog', { name: /create new project/i });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('never lets Tab reach the page behind the wizard', async () => {
    const user = userEvent.setup();
    renderWizardOverPage();

    const dialog = screen.getByRole('dialog', { name: /create new project/i });
    const behind = screen.getByRole('button', { name: 'behind the wizard' });

    for (let press = 0; press < 12; press += 1) {
      await user.tab();
      expect(document.activeElement).not.toBe(behind);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('cycles backwards within the wizard too', async () => {
    const user = userEvent.setup();
    renderWizardOverPage();

    const dialog = screen.getByRole('dialog', { name: /create new project/i });
    const behind = screen.getByRole('button', { name: 'behind the wizard' });

    for (let press = 0; press < 12; press += 1) {
      await user.tab({ shift: true });
      expect(document.activeElement).not.toBe(behind);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('hands the trap to the folder picker while it is stacked, and back on close', async () => {
    const user = userEvent.setup();
    renderWizardOverPage();

    const wizard = screen.getByRole('dialog', { name: /create new project/i });
    const browse = screen.getByRole('button', { name: 'Browse folders' });
    await user.click(browse);

    const picker = await screen.findByRole('dialog', { name: 'Select Folder' });
    expect(picker.contains(document.activeElement)).toBe(true);

    // The topmost overlay owns Tab: cycling stays inside the picker.
    screen.getByRole('button', { name: 'Use this folder' }).focus();
    await user.tab();
    expect(picker.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Show all folders' }),
    );

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Select Folder' })).toBeNull(),
    );

    // Closing the picker returns focus to the control that opened it...
    expect(document.activeElement).toBe(browse);

    // ...and the wizard is trapping again.
    for (let press = 0; press < 12; press += 1) {
      await user.tab();
      expect(wizard.contains(document.activeElement)).toBe(true);
    }
  });
});
