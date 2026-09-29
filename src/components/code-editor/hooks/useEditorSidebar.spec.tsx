import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../types/app';

import { useEditorSidebar } from './useEditorSidebar';

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

// The resize drag handler now rAF-throttles: it stores the latest mousemove
// event and applies it on the next animation frame instead of synchronously
// on every event (see the sidebar/code-editor perf audit's finding 5). Tests
// that dispatch a mousemove and assert the resulting width need to flush one
// frame first.
const flushAnimationFrame = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => resolve());
});

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

  it('does not start a resize on mobile', async () => {
    render(<Harness project={project} isMobile />);
    const event = { preventDefault: vi.fn() } as unknown as React.MouseEvent<HTMLDivElement>;

    act(() => sidebar.handleResizeStart(event));
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
      await flushAnimationFrame();
    });

    // Resize never armed, so a subsequent drag has no effect on width.
    expect(sidebar.editorWidth).toBe(500);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('drags the handle to resize within min/max bounds, then stops on mouseup', async () => {
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

    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
      await flushAnimationFrame();
    });
    expect(sidebar.editorWidth).toBe(400);

    // Below min width: ignored, width stays put.
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 999 }));
      await flushAnimationFrame();
    });
    expect(sidebar.editorWidth).toBe(400);

    // Above max width (80% of 1000 = 800): ignored.
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: -100 }));
      await flushAnimationFrame();
    });
    expect(sidebar.editorWidth).toBe(400);

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(document.body.style.cursor).toBe('');

    // Resizing has stopped, so further drags no longer move the width.
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
      await flushAnimationFrame();
    });
    expect(sidebar.editorWidth).toBe(400);
  });

  // Two mousemove events within the same animation frame must coalesce into
  // one applied update (using only the latest position), not two — that's
  // the whole point of the rAF gate (finding 5).
  it('coalesces multiple mousemove events within one animation frame', async () => {
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

    await act(async () => {
      // Two events fired back-to-back, before any animation frame runs.
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 550 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
      await flushAnimationFrame();
    });

    // Only the latest (clientX: 600 -> width 400) should have been applied.
    expect(sidebar.editorWidth).toBe(400);
  });

  it('mousemove is a no-op while not resizing, and cleans up when the container is missing', async () => {
    render(<Harness project={project} />);
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
      await flushAnimationFrame();
    });
    expect(sidebar.editorWidth).toBe(500);
  });

  it('mousemove is a no-op once the handle is detached from its container', async () => {
    // Simulates the handle's immediate parent being removed from the DOM out
    // from under an in-flight drag (e.g. the editor panel closing mid-resize):
    // `editorContainer.parentElement` (mainContainer) goes null, and the resize
    // math must bail out instead of throwing on `getBoundingClientRect`.
    const { getByTestId } = render(<Harness project={project} />);
    const handle = getByTestId('handle');
    const editorContainer = handle.parentElement as HTMLElement;

    const startEvent = { preventDefault: vi.fn() } as unknown as React.MouseEvent<HTMLDivElement>;
    act(() => sidebar.handleResizeStart(startEvent));

    editorContainer.remove();

    await expect(
      act(async () => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
        await flushAnimationFrame();
      }),
    ).resolves.not.toThrow();
    expect(sidebar.editorWidth).toBe(500);
  });
});
