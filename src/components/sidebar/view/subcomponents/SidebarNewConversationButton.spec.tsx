import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import SidebarNewConversationButton from './SidebarNewConversationButton';

import i18n from '@/i18n/config.js';
import type { Project } from '@/types/app';

/*
 * Picking a folder for a new conversation searches the *spaces* list, and a
 * space row is minted for every session cwd — so an agent run inside
 * `<repo>/tools/x`, a scratchpad dir, or a deleted worktree all became
 * searchable folders (#332). cmdk matches whatever is rendered, so the fix is
 * the listing: repository roots only, with a toggle for the rest.
 */

function project(overrides: Partial<Project> & Pick<Project, 'projectId'>): Project {
  return {
    displayName: overrides.projectId,
    fullPath: `/home/u/repos/${overrides.projectId}`,
    ...overrides,
  } as Project;
}

const mind = project({ projectId: 'mind', displayName: 'mind', isRepository: true });
const mindSubfolder = project({
  projectId: 'mind-tools',
  displayName: 'harness-token-audit',
  fullPath: '/home/u/repos/mind/tools/harness-token-audit',
  isRepository: false,
});

function renderPicker(projects: Project[] = [mind, mindSubfolder]) {
  const onNewConversation = vi.fn();
  const onCreateProject = vi.fn();

  render(
    <SidebarNewConversationButton
      projects={projects}
      onNewConversation={onNewConversation}
      onCreateProject={onCreateProject}
      t={i18n.getFixedT('en', 'sidebar')}
    />,
  );

  return { onNewConversation, onCreateProject };
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New conversation' }));
  return screen.getByPlaceholderText('Search folders…');
}

describe('SidebarNewConversationButton — repository-root spaces only (#332)', () => {
  it('lists repository roots and leaves subfolder spaces out', async () => {
    const user = userEvent.setup();
    renderPicker();

    await openPicker(user);

    expect(screen.getByText('mind')).toBeInTheDocument();
    expect(screen.queryByText('harness-token-audit')).toBeNull();
  });

  it('does not match a subfolder space when its name is typed into the search', async () => {
    const user = userEvent.setup();
    renderPicker();

    const search = await openPicker(user);
    await user.type(search, 'harness');

    expect(screen.queryByText('harness-token-audit')).toBeNull();
    expect(screen.getByText('No folders found')).toBeInTheDocument();
  });

  it('does not match a subfolder by its path either (the path is part of the haystack)', async () => {
    const user = userEvent.setup();
    renderPicker();

    const search = await openPicker(user);
    await user.type(search, 'tools');

    expect(screen.queryByText('/home/u/repos/mind/tools/harness-token-audit')).toBeNull();
  });

  it('reveals the hidden spaces through the "show all folders" escape hatch', async () => {
    const user = userEvent.setup();
    renderPicker();

    await openPicker(user);
    await user.click(screen.getByRole('button', { name: 'Show all folders (1 more)' }));

    expect(screen.getByText('harness-token-audit')).toBeInTheDocument();
    // …and back again, so the toggle isn't a one-way door.
    await user.click(screen.getByRole('button', { name: 'Show repositories only' }));
    expect(screen.queryByText('harness-token-audit')).toBeNull();
  });

  it('starts a conversation in the space that was picked', async () => {
    const user = userEvent.setup();
    const { onNewConversation } = renderPicker();

    await openPicker(user);
    await user.click(screen.getByText('mind'));

    expect(onNewConversation).toHaveBeenCalledWith(mind);
  });

  it('offers no toggle when every space is a repository root', async () => {
    const user = userEvent.setup();
    renderPicker([mind]);

    await openPicker(user);

    expect(screen.queryByRole('button', { name: /Show all folders/ })).toBeNull();
  });

  it('lists every space when the server never sent the repository flag', async () => {
    const user = userEvent.setup();
    renderPicker([project({ projectId: 'legacy-a' }), project({ projectId: 'legacy-b' })]);

    await openPicker(user);

    expect(screen.getByText('legacy-a')).toBeInTheDocument();
    expect(screen.getByText('legacy-b')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show all folders/ })).toBeNull();
  });

  /*
   * #366: opening the folder picker is a *browse* action — it must not autofocus
   * the search field and pop the keyboard over the folder list. Typing to filter
   * is the fallback, matching the model selector's deliberate no-autofocus policy.
   */
  it('does not autofocus the folder search on open', async () => {
    const user = userEvent.setup();
    renderPicker();

    const input = await openPicker(user);

    expect(input).not.toHaveFocus();
  });
});
