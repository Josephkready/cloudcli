import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PlanDisplay } from './PlanDisplay';
import PermissionContext from '../../../../contexts/PermissionContext';
import type { PermissionContextValue } from '../../../../contexts/PermissionContext';

afterEach(() => {
  cleanup();
});

function renderWithPermission(ui: React.ReactElement, value: PermissionContextValue | null) {
  return render(
    <PermissionContext.Provider value={value}>{ui}</PermissionContext.Provider>,
  );
}

describe('PlanDisplay', () => {
  it('renders the title and markdown content', () => {
    renderWithPermission(
      <PlanDisplay title="Implementation plan" content="# Step 1\n\nDo the thing" toolName="ExitPlanMode" />,
      null,
    );
    expect(screen.getByText('Implementation plan')).toBeTruthy();
  });

  it('shows a shimmering "Generating plan..." placeholder while streaming with no content yet', () => {
    renderWithPermission(
      <PlanDisplay title="Plan" content="" isStreaming toolName="ExitPlanMode" />,
      null,
    );
    expect(screen.getByText('Generating plan...')).toBeTruthy();
  });

  it('renders nothing in the body when not streaming and there is no content', () => {
    const { container } = renderWithPermission(
      <PlanDisplay title="Plan" content="" toolName="ExitPlanMode" />,
      null,
    );
    expect(container.querySelector('.prose')).toBeNull();
    expect(screen.queryByText('Generating plan...')).toBeNull();
  });

  it('shows raw parameters behind a toggle when showRawParameters and rawContent are set', () => {
    renderWithPermission(
      <PlanDisplay
        title="Plan"
        content="body"
        toolName="ExitPlanMode"
        showRawParameters
        rawContent='{"plan":"body"}'
      />,
      null,
    );
    expect(screen.getByText('raw params')).toBeTruthy();
    expect(screen.getByText('{"plan":"body"}')).toBeTruthy();
  });

  it('does not show raw parameters when showRawParameters is false', () => {
    renderWithPermission(
      <PlanDisplay title="Plan" content="body" toolName="ExitPlanMode" rawContent="raw" />,
      null,
    );
    expect(screen.queryByText('raw params')).toBeNull();
  });

  it('shows no footer when there is no pending ExitPlanMode permission request', () => {
    renderWithPermission(
      <PlanDisplay title="Plan" content="body" toolName="ExitPlanMode" />,
      { pendingPermissionRequests: [], handlePermissionDecision: vi.fn() },
    );
    expect(screen.queryByText('Build')).toBeNull();
    expect(screen.queryByText('Revise')).toBeNull();
  });

  it('shows Build/Revise footer when a pending ExitPlanMode request exists, and wires the decisions', () => {
    const handlePermissionDecision = vi.fn();
    renderWithPermission(
      <PlanDisplay title="Plan" content="body" toolName="ExitPlanMode" />,
      {
        pendingPermissionRequests: [{ requestId: 'req-1', toolName: 'ExitPlanMode', input: {} }],
        handlePermissionDecision,
      },
    );

    fireEvent.click(screen.getByText('Build'));
    expect(handlePermissionDecision).toHaveBeenCalledWith('req-1', { allow: true });

    fireEvent.click(screen.getByText('Revise'));
    expect(handlePermissionDecision).toHaveBeenCalledWith('req-1', {
      allow: false,
      message: 'User asked to revise the plan',
    });
  });

  it('also matches the lowercase exit_plan_mode tool name for the pending request', () => {
    renderWithPermission(
      <PlanDisplay title="Plan" content="body" toolName="exit_plan_mode" />,
      {
        pendingPermissionRequests: [{ requestId: 'req-2', toolName: 'exit_plan_mode', input: {} }],
        handlePermissionDecision: vi.fn(),
      },
    );
    expect(screen.getByText('Build')).toBeTruthy();
  });

  it('toggles the collapsible section open/closed via the chevron trigger', () => {
    renderWithPermission(
      <PlanDisplay title="Plan" content="hello" toolName="ExitPlanMode" defaultOpen={false} />,
      null,
    );
    fireEvent.click(screen.getByText('Toggle plan'));
    expect(screen.getByText('hello')).toBeTruthy();
  });
});
