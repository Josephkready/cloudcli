import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import type { Project } from '../../../../types/app';
import type { DeleteProjectConfirmation, SessionDeleteConfirmation } from '../../types/types';

import SidebarModals from './SidebarModals';

// Avoid pulling in the real (heavy) Settings/ProjectCreationWizard chunks:
// stub `lazySurface` so it returns a plain, synchronously-rendered component
// instead of a `React.lazy` wrapper around a dynamic import.
vi.mock('../../../lazy/LazySurface', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  lazySurface: (loader: () => Promise<{ default: unknown }>) => {
    const name = String(loader);
    if (name.includes('settings')) {
      return (props: Record<string, unknown>) => (
        <div data-testid="settings-stub">
          settings-open:{String(props.isOpen)}:tab:{String(props.initialTab)}:projects:{JSON.stringify(props.projects)}
        </div>
      );
    }
    return () => <div data-testid="wizard-stub">wizard</div>;
  },
}));

const t = ((key: string, opts?: string | { defaultValue?: string; count?: number }) => {
  if (typeof opts === 'object' && typeof opts.defaultValue === 'string') {
    return opts.defaultValue;
  }
  if (typeof opts === 'string') {
    return opts;
  }
  return key;
}) as unknown as TFunction;

const project: Project = {
  projectId: 'proj-1',
  displayName: 'My Project',
  fullPath: '/home/proj-1',
} as Project;

function baseProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    projects: [project],
    showSettings: false,
    settingsInitialTab: 'general',
    onCloseSettings: vi.fn(),
    showNewProject: false,
    onCloseNewProject: vi.fn(),
    onProjectCreated: vi.fn(),
    deleteConfirmation: null,
    onCancelDeleteProject: vi.fn(),
    onConfirmDeleteProject: vi.fn(),
    sessionDeleteConfirmation: null,
    onCancelDeleteSession: vi.fn(),
    onConfirmDeleteSession: vi.fn(),
    t,
    ...overrides,
  };
}

describe('SidebarModals', () => {
  it('renders nothing visible when every surface is closed', () => {
    const { container } = render(<SidebarModals {...(baseProps() as any)} />);
    expect(container.querySelector('[data-testid="settings-stub"]')).toBeNull();
    expect(container.querySelector('[data-testid="wizard-stub"]')).toBeNull();
    expect(screen.queryByText('deleteConfirmation.deleteProject')).not.toBeInTheDocument();
  });

  it('renders the settings surface with normalized projects when open', () => {
    render(<SidebarModals {...(baseProps({ showSettings: true, settingsInitialTab: 'voice' }) as any)} />);
    const stub = screen.getByTestId('settings-stub');
    expect(stub.textContent).toContain('settings-open:true');
    expect(stub.textContent).toContain('tab:voice');
    expect(stub.textContent).toContain('My Project');
  });

  it('renders the new-project wizard when showNewProject is true', () => {
    render(<SidebarModals {...(baseProps({ showNewProject: true }) as any)} />);
    expect(screen.getByTestId('wizard-stub')).toBeInTheDocument();
  });

  it('shows the delete-project confirmation with the session count when sessions exist', () => {
    const deleteConfirmation: DeleteProjectConfirmation = {
      project: { projectId: 'p1', displayName: 'Doomed Project' },
      sessionCount: 3,
    } as DeleteProjectConfirmation;
    render(<SidebarModals {...(baseProps({ deleteConfirmation }) as any)} />);

    expect(screen.getByText('deleteConfirmation.deleteProject')).toBeInTheDocument();
    expect(screen.getByText('Doomed Project')).toBeInTheDocument();
    expect(screen.getByText('deleteConfirmation.sessionCount')).toBeInTheDocument();
  });

  it('falls back to the projectId when the project has no displayName', () => {
    const deleteConfirmation: DeleteProjectConfirmation = {
      project: { projectId: 'p1' },
      sessionCount: 0,
    } as DeleteProjectConfirmation;
    render(<SidebarModals {...(baseProps({ deleteConfirmation }) as any)} />);

    expect(screen.getByText('p1')).toBeInTheDocument();
    expect(screen.queryByText('deleteConfirmation.sessionCount')).not.toBeInTheDocument();
  });

  it('archives, deletes, and cancels a project deletion from the confirmation dialog', async () => {
    const onConfirmDeleteProject = vi.fn();
    const onCancelDeleteProject = vi.fn();
    const deleteConfirmation: DeleteProjectConfirmation = {
      project: { projectId: 'p1', displayName: 'Doomed Project' },
      sessionCount: 1,
    } as DeleteProjectConfirmation;
    const user = userEvent.setup();
    render(<SidebarModals {...(baseProps({ deleteConfirmation, onConfirmDeleteProject, onCancelDeleteProject }) as any)} />);

    await user.click(screen.getByText('Archive project'));
    expect(onConfirmDeleteProject).toHaveBeenCalledWith(false);

    await user.click(screen.getByText('deleteConfirmation.deleteAllData'));
    expect(onConfirmDeleteProject).toHaveBeenCalledWith(true);

    await user.click(screen.getByText('actions.cancel'));
    expect(onCancelDeleteProject).toHaveBeenCalled();
  });

  it('shows the session-delete confirmation with the archive-not-yet-archived notice and archive action', async () => {
    const onConfirmDeleteSession = vi.fn();
    const onCancelDeleteSession = vi.fn();
    const sessionDeleteConfirmation: SessionDeleteConfirmation = {
      sessionTitle: 'My chat',
      isArchived: false,
    } as SessionDeleteConfirmation;
    const user = userEvent.setup();
    render(
      <SidebarModals
        {...(baseProps({ sessionDeleteConfirmation, onConfirmDeleteSession, onCancelDeleteSession }) as any)}
      />,
    );

    expect(screen.getByText('My chat')).toBeInTheDocument();
    expect(screen.getByText('Archive keeps the session out of the active list while preserving its history.')).toBeInTheDocument();

    await user.click(screen.getByText('Archive session'));
    expect(onConfirmDeleteSession).toHaveBeenCalledWith(false);

    await user.click(screen.getByText('Delete permanently'));
    expect(onConfirmDeleteSession).toHaveBeenCalledWith(true);

    await user.click(screen.getByText('actions.cancel'));
    expect(onCancelDeleteSession).toHaveBeenCalled();
  });

  it('shows the already-archived notice and hides the archive action for an archived session', () => {
    const sessionDeleteConfirmation: SessionDeleteConfirmation = {
      sessionTitle: '',
      isArchived: true,
    } as SessionDeleteConfirmation;
    render(<SidebarModals {...(baseProps({ sessionDeleteConfirmation }) as any)} />);

    expect(screen.getByText('sessions.unnamed')).toBeInTheDocument();
    expect(screen.getByText('This session is already archived. You can keep it hidden or delete it permanently.')).toBeInTheDocument();
    expect(screen.queryByText('Archive session')).not.toBeInTheDocument();
  });
});
