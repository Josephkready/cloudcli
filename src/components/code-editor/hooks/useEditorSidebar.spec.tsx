import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useEditorSidebar } from './useEditorSidebar';
import type { Project } from '../../../types/app';

type Sidebar = ReturnType<typeof useEditorSidebar>;

let sidebar: Sidebar;

function Harness({ isMobile = false, project = null }: { isMobile?: boolean; project?: Project | null }) {
  sidebar = useEditorSidebar({ selectedProject: project, isMobile, initialWidth: 500 });
  return (
    <div data-testid="main">
      <div>
        <div ref={sidebar.resizeHandleRef} data-testid="handle" />
      </div>
    </div>
  );
}

const project = { projectId: 'proj-1' } as Project;

describe('useEditorSidebar', () => {
  it('opens a file, normalizing backslashes and deriving the display name', () => {
    render(<Harness project={project} />);

    act(() => sidebar.handleFileOpen('some\\windows\\path.txt'));

    expect(sidebar.editingFile).toEqual({
      name: 'path.txt',
      path: 'some\\windows\\path.txt',
      projectId: 'proj-1',
      diffInfo: null,
    });
  });

  it('falls back to the raw path as the name when there is no separator', () => {
    render(<Harness project={project} />);
    act(() => sidebar.handleFileOpen('README.md'));
    expect(sidebar.editingFile?.name).toBe('README.md');
  });

  it('forwards diff info when provided', () => {
    render(<Harness project={project} />);
    const diffInfo = { old_string: 'a', new_string: 'b' };
    act(() => sidebar.handleFileOpen('a.ts', diffInfo));
    expect(sidebar.editingFile?.diffInfo).toBe(diffInfo);
  });

  it('closing collapses expansion state and clears the editing file', () => {
    render(<Harness project={project} />);
    act(() => sidebar.handleFileOpen('a.ts'));
    act(() => sidebar.handleToggleEditorExpand());
    expect(sidebar.editorExpanded).toBe(true);

    act(() => sidebar.handleCloseEditor());

    expect(sidebar.editingFile).toBeNull();
    expect(sidebar.editorExpanded).toBe(false);
  });

  it('does not start a resize on mobile', () => {
    render(<Harness project={project} isMobile />);
    const event = { preventDefault: vi.fn() } as unknown as React.MouseEvent<HTMLDivElement>;

    act(() => sidebar.handleResizeStart(event));
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
    });

    // Resize never armed, so a subsequent drag has no effect on width.
    expect(sidebar.editorWidth).toBe(500);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('drags the handle to resize within min/max bounds, then stops on mouseup', () => {
    const { getByTestId } = render(<Harness project={project} />);
    const container = getByTestId('main');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      right: 1000,
      width: 1000,
      left: 0,
      top: 0,
      bottom: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const startEvent = { preventDefault: vi.fn() } as unknown as React.MouseEvent<HTMLDivElement>;
    act(() => sidebar.handleResizeStart(startEvent));
    expect(startEvent.preventDefault).toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('col-resize');

    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
    });
    expect(sidebar.editorWidth).toBe(400);

    // Below min width: ignored, width stays put.
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 999 }));
    });
    expect(sidebar.editorWidth).toBe(400);

    // Above max width (80% of 1000 = 800): ignored.
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: -100 }));
    });
    expect(sidebar.editorWidth).toBe(400);

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(document.body.style.cursor).toBe('');

    // Resizing has stopped, so further drags no longer move the width.
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    });
    expect(sidebar.editorWidth).toBe(400);
  });

  it('mousemove is a no-op while not resizing, and cleans up when the container is missing', () => {
    render(<Harness project={project} />);
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
    });
    expect(sidebar.editorWidth).toBe(500);
  });
});
