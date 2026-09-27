import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import PermissionRequestsBanner from './PermissionRequestsBanner';
import { CLAUDE_SETTINGS_KEY } from '../../../../utils/claudeSettings';

afterEach(() => {
  cleanup();
});

const baseProps = () => ({
  handlePermissionDecision: vi.fn(),
  handleGrantToolPermission: vi.fn().mockReturnValue({ success: true }),
});

describe('PermissionRequestsBanner', () => {
  it('renders nothing when there are no pending requests', () => {
    const { container } = render(
      <PermissionRequestsBanner pendingPermissionRequests={[]} {...baseProps()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('filters out plan-mode requests (handled inline by PlanDisplay)', () => {
    const { container } = render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[
          { requestId: '1', toolName: 'ExitPlanMode', input: {} },
          { requestId: '2', toolName: 'exit_plan_mode', input: {} },
        ]}
        {...baseProps()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a generic confirmation with tool name and Deny/Allow controls', () => {
    const props = baseProps();
    render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[{ requestId: 'req-1', toolName: 'Bash', input: { command: 'ls -la' } }]}
        {...props}
      />,
    );

    expect(screen.getByText('Permission required')).toBeTruthy();
    expect(screen.getByText('Bash')).toBeTruthy();
    // Raw input is shown behind a details/summary toggle.
    expect(screen.getByText('View tool input')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(props.handlePermissionDecision).toHaveBeenCalledWith('req-1', {
      allow: false,
      message: 'User denied tool use',
    });
  });

  it('grants and remembers a permission entry, applying it to every matching pending request', () => {
    const props = baseProps();
    render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[
          { requestId: 'req-1', toolName: 'Bash', input: { command: 'ls -la' } },
          { requestId: 'req-2', toolName: 'Bash', input: { command: 'ls -R' } },
          { requestId: 'req-3', toolName: 'Read', input: { file_path: '/a' } },
        ]}
        {...props}
      />,
    );

    const allowRememberButtons = screen.getAllByRole('button', { name: 'Allow & remember' });
    fireEvent.click(allowRememberButtons[0]);

    expect(props.handleGrantToolPermission).toHaveBeenCalledWith({
      entry: 'Bash(ls:*)',
      toolName: 'Bash',
    });
    // Both Bash requests share the same derived entry ("Bash(ls:*)") and should
    // both be resolved by remembering it once.
    expect(props.handlePermissionDecision).toHaveBeenCalledWith(['req-1', 'req-2'], {
      allow: true,
      rememberEntry: 'Bash(ls:*)',
    });
  });

  it('shows "Allow (saved)" and skips re-granting when the entry is already allowed', () => {
    window.localStorage.setItem(
      CLAUDE_SETTINGS_KEY,
      JSON.stringify({ allowedTools: ['Bash(ls:*)'], disallowedTools: [] }),
    );
    const props = baseProps();
    render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[{ requestId: 'req-1', toolName: 'Bash', input: { command: 'ls -la' } }]}
        {...props}
      />,
    );

    const rememberButton = screen.getByRole('button', { name: 'Allow (saved)' });
    fireEvent.click(rememberButton);

    expect(props.handleGrantToolPermission).not.toHaveBeenCalled();
    expect(props.handlePermissionDecision).toHaveBeenCalledWith(['req-1'], {
      allow: true,
      rememberEntry: 'Bash(ls:*)',
    });
  });

  it('allows once without touching remembered settings', () => {
    const props = baseProps();
    render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[{ requestId: 'req-1', toolName: 'Read', input: { file_path: '/a' } }]}
        {...props}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(props.handlePermissionDecision).toHaveBeenCalledWith('req-1', { allow: true });
  });

  it('disables Allow & remember and hides the allow rule when no permission entry can be derived', () => {
    render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[{ requestId: 'req-1', toolName: '', input: {} }]}
        {...baseProps()}
      />,
    );

    // Empty toolName -> buildClaudeToolPermissionEntry returns null.
    const rememberButton = screen.getByRole('button', { name: 'Allow & remember' });
    expect(rememberButton).toHaveProperty('disabled', true);
    expect(screen.queryByText(/Allow rule:/)).toBeNull();
  });

  it('renders a registered custom permission panel instead of the generic confirmation', () => {
    render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[
          {
            requestId: 'req-1',
            toolName: 'AskUserQuestion',
            input: { questions: [{ question: 'Pick?', options: [{ label: 'A' }] }] },
          },
        ]}
        {...baseProps()}
      />,
    );

    // The AskUserQuestion tool is registered against a custom panel at module
    // load, so the generic "Permission required" confirmation must not render.
    expect(screen.queryByText('Permission required')).toBeNull();
  });
});
