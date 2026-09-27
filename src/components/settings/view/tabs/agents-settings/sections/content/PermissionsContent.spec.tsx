import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import PermissionsContent from './PermissionsContent';

describe('PermissionsContent - claude agent', () => {
  it('toggles skip permissions checkbox', async () => {
    const user = userEvent.setup();
    const onSkipPermissionsChange = vi.fn();

    render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={onSkipPermissionsChange}
        allowedTools={[]}
        onAllowedToolsChange={vi.fn()}
        disallowedTools={[]}
        onDisallowedToolsChange={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(onSkipPermissionsChange).toHaveBeenCalledWith(true);
  });

  it('adds a new allowed tool via the input and button', async () => {
    const user = userEvent.setup();
    const onAllowedToolsChange = vi.fn();

    render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={vi.fn()}
        allowedTools={[]}
        onAllowedToolsChange={onAllowedToolsChange}
        disallowedTools={[]}
        onDisallowedToolsChange={vi.fn()}
      />,
    );

    const input = screen.getAllByPlaceholderText(/e\.g\./i)[0] as HTMLInputElement;
    await user.type(input, 'CustomTool');
    // Button is disabled unless there's text; find add buttons (multiple exist)
    const addButtons = screen.getAllByRole('button', { name: /add/i });
    await user.click(addButtons[0]);

    expect(onAllowedToolsChange).toHaveBeenCalledWith(['CustomTool']);
  });

  it('does not add an allowed tool for whitespace-only input', async () => {
    const onAllowedToolsChange = vi.fn();

    render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={vi.fn()}
        allowedTools={[]}
        onAllowedToolsChange={onAllowedToolsChange}
        disallowedTools={[]}
        onDisallowedToolsChange={vi.fn()}
      />,
    );

    // The add button should be disabled when input is empty
    const addButtons = screen.getAllByRole('button', { name: /add/i });
    expect(addButtons[0]).toBeDisabled();
    expect(onAllowedToolsChange).not.toHaveBeenCalled();
  });

  it('adds a common quick-add tool and disables it once added', async () => {
    const user = userEvent.setup();
    const onAllowedToolsChange = vi.fn();

    render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={vi.fn()}
        allowedTools={['Write']}
        onAllowedToolsChange={onAllowedToolsChange}
        disallowedTools={[]}
        onDisallowedToolsChange={vi.fn()}
      />,
    );

    const writeQuickAddButton = screen.getAllByRole('button', { name: 'Write' })[0];
    expect(writeQuickAddButton).toBeDisabled();

    const readQuickAddButton = screen.getByRole('button', { name: 'Read' });
    await user.click(readQuickAddButton);
    expect(onAllowedToolsChange).toHaveBeenCalledWith(['Write', 'Read']);
  });

  it('renders allowed tools list and removes one on click', async () => {
    const user = userEvent.setup();
    const onAllowedToolsChange = vi.fn();

    render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={vi.fn()}
        allowedTools={['Read', 'Edit']}
        onAllowedToolsChange={onAllowedToolsChange}
        disallowedTools={[]}
        onDisallowedToolsChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Read', { selector: 'span' })).toBeInTheDocument();

    const readRow = screen.getByText('Read', { selector: 'span' }).closest('div');
    const removeButton = within(readRow as HTMLElement).getByRole('button');
    await user.click(removeButton);

    expect(onAllowedToolsChange).toHaveBeenCalledWith(['Edit']);
  });

  it('shows empty state when no allowed tools exist', () => {
    render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={vi.fn()}
        allowedTools={[]}
        onAllowedToolsChange={vi.fn()}
        disallowedTools={[]}
        onDisallowedToolsChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/no allowed tools/i)).toBeInTheDocument();
  });

  it('adds and removes a disallowed tool, and shows empty state', async () => {
    const user = userEvent.setup();
    const onDisallowedToolsChange = vi.fn();

    const { rerender } = render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={vi.fn()}
        allowedTools={[]}
        onAllowedToolsChange={vi.fn()}
        disallowedTools={[]}
        onDisallowedToolsChange={onDisallowedToolsChange}
      />,
    );

    expect(screen.getByText(/no blocked tools/i)).toBeInTheDocument();

    const inputs = screen.getAllByRole('textbox');
    const blockedInput = inputs[1];
    await user.type(blockedInput, 'Bash(rm:*)');
    await user.keyboard('{Enter}');

    expect(onDisallowedToolsChange).toHaveBeenCalledWith(['Bash(rm:*)']);

    rerender(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={vi.fn()}
        allowedTools={[]}
        onAllowedToolsChange={vi.fn()}
        disallowedTools={['Bash(rm:*)']}
        onDisallowedToolsChange={onDisallowedToolsChange}
      />,
    );

    const blockedRow = screen.getByText('Bash(rm:*)', { selector: 'span' }).closest('div');
    const removeButton = within(blockedRow as HTMLElement).getByRole('button');
    await user.click(removeButton);
    expect(onDisallowedToolsChange).toHaveBeenCalledWith([]);
  });

  it('does not add a duplicate allowed tool', async () => {
    const user = userEvent.setup();
    const onAllowedToolsChange = vi.fn();

    render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={vi.fn()}
        allowedTools={['Read']}
        onAllowedToolsChange={onAllowedToolsChange}
        disallowedTools={[]}
        onDisallowedToolsChange={vi.fn()}
      />,
    );

    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs[0], 'Read');
    await user.keyboard('{Enter}');

    expect(onAllowedToolsChange).not.toHaveBeenCalled();
  });

  it('does not add a duplicate disallowed tool', async () => {
    const user = userEvent.setup();
    const onDisallowedToolsChange = vi.fn();

    render(
      <PermissionsContent
        agent="claude"
        skipPermissions={false}
        onSkipPermissionsChange={vi.fn()}
        allowedTools={[]}
        onAllowedToolsChange={vi.fn()}
        disallowedTools={['Bash(rm:*)']}
        onDisallowedToolsChange={onDisallowedToolsChange}
      />,
    );

    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs[1], 'Bash(rm:*)');
    await user.keyboard('{Enter}');

    expect(onDisallowedToolsChange).not.toHaveBeenCalled();
  });
});

describe('PermissionsContent - codex agent', () => {
  it('selects default permission mode and shows radio checked', () => {
    render(
      <PermissionsContent
        agent="codex"
        permissionMode="default"
        onPermissionModeChange={vi.fn()}
      />,
    );

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
    expect(radios[2].checked).toBe(false);
  });

  it('calls onPermissionModeChange when clicking the acceptEdits card', async () => {
    const user = userEvent.setup();
    const onPermissionModeChange = vi.fn();

    render(
      <PermissionsContent
        agent="codex"
        permissionMode="default"
        onPermissionModeChange={onPermissionModeChange}
      />,
    );

    const radios = screen.getAllByRole('radio');
    await user.click(radios[1]);
    expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
  });

  it('calls onPermissionModeChange when clicking the bypassPermissions container', async () => {
    const user = userEvent.setup();
    const onPermissionModeChange = vi.fn();

    render(
      <PermissionsContent
        agent="codex"
        permissionMode="acceptEdits"
        onPermissionModeChange={onPermissionModeChange}
      />,
    );

    const radios = screen.getAllByRole('radio');
    await user.click(radios[2].closest('div[class*="cursor-pointer"]') as HTMLElement);
    expect(onPermissionModeChange).toHaveBeenCalledWith('bypassPermissions');
  });

  it('renders technical details in a details/summary element', async () => {
    const user = userEvent.setup();

    render(
      <PermissionsContent
        agent="codex"
        permissionMode="bypassPermissions"
        onPermissionModeChange={vi.fn()}
      />,
    );

    const summary = screen.getByText(/technical/i);
    await user.click(summary);
    expect(screen.getByText(/default:/i)).toBeInTheDocument();
  });
});
