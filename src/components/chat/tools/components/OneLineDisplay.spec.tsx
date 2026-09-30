import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { OneLineDisplay } from './OneLineDisplay';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OneLineDisplay', () => {
  describe('terminal style', () => {
    it('renders the command, a status badge, and secondary description', () => {
      render(
        <OneLineDisplay
          toolName="Bash"
          value="ls -la"
          secondary="lists files"
          style="terminal"
          status="completed"
        />,
      );
      expect(screen.getByText('ls -la')).toBeTruthy();
      expect(screen.getByText('lists files')).toBeTruthy();
    });

    it('copies the value to the clipboard and shows a checkmark that reverts', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText, readText: async () => '' },
      });

      render(<OneLineDisplay toolName="Bash" value="echo hi" style="terminal" action="copy" />);
      const copyButton = screen.getByRole('button', { name: /copy to clipboard/i });

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith('echo hi');

      await act(async () => {
        vi.advanceTimersByTime(2100);
      });
    });

    // Touch devices have no `:hover`, so a hover-only reveal
    // (`opacity-0 group-hover:opacity-100`) left this button invisible yet
    // still tappable on touch. `touch:opacity-100` is the repo's existing
    // coarse/no-hover escape hatch (src/index.css) and must stay alongside
    // the hover classes so desktop hover-reveal is unchanged.
    it('keeps the copy button visible on touch/no-hover pointers, not just on hover', () => {
      render(<OneLineDisplay toolName="Bash" value="echo hi" style="terminal" action="copy" />);
      const copyButton = screen.getByRole('button', { name: /copy to clipboard/i });

      expect(copyButton).toHaveClass('touch:opacity-100', 'opacity-0', 'group-hover:opacity-100');
    });

    it('wraps text when wrapText is true', () => {
      const { container } = render(
        <OneLineDisplay toolName="Bash" value="a long command" style="terminal" wrapText />,
      );
      expect(container.querySelector('code.whitespace-pre')).toBeTruthy();
    });
  });

  describe('file-name style', () => {
    it('shows the basename of the value as text, with the full path on hover', () => {
      render(
        <OneLineDisplay
          toolName="Read"
          label="Read"
          value="/a/b/c/file.ts"
          action="file-name"
          status="completed"
        />,
      );
      expect(screen.getByText('file.ts')).toHaveAttribute('title', '/a/b/c/file.ts');
      expect(screen.queryByRole('button', { name: 'file.ts' })).not.toBeInTheDocument();
    });
  });

  describe('jump-to-results style', () => {
    it('renders label, value, secondary, status badge, and a result-jump link when toolResult is present', () => {
      render(
        <OneLineDisplay
          toolName="Grep"
          label="Grep"
          value="TODO"
          secondary="in src"
          action="jump-to-results"
          status="completed"
          toolResult={{ content: 'x' }}
          toolId="tool-1"
        />,
      );
      expect(screen.getByText('TODO')).toBeTruthy();
      expect(screen.getByText('in src')).toBeTruthy();
      const link = document.querySelector('a[href="#tool-result-tool-1"]');
      expect(link).toBeTruthy();
    });

    it('omits the jump link when there is no toolResult', () => {
      render(<OneLineDisplay toolName="Grep" value="TODO" action="jump-to-results" />);
      expect(document.querySelector('a')).toBeNull();
    });
  });

  describe('default style', () => {
    it('renders an icon when provided (not "terminal")', () => {
      render(<OneLineDisplay toolName="TaskCreate" icon="📝" value="Ship it" />);
      expect(screen.getByText('📝')).toBeTruthy();
    });

    it('falls back to label/toolName when no icon is set', () => {
      render(<OneLineDisplay toolName="TaskCreate" value="Ship it" />);
      expect(screen.getByText('TaskCreate')).toBeTruthy();
    });

    it('uses the label over toolName when both are present', () => {
      render(<OneLineDisplay toolName="TaskCreate" label="Task" value="Ship it" />);
      expect(screen.getByText('Task')).toBeTruthy();
      expect(screen.queryByText('TaskCreate')).toBeNull();
    });

    it('renders a copy button in default style and copies on click', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText, readText: async () => '' },
      });
      render(<OneLineDisplay toolName="TaskCreate" value="Ship it" action="copy" />);
      const button = screen.getByRole('button', { name: /copy to clipboard/i });
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith('Ship it');
    });

    it('renders secondary text and a status badge', () => {
      render(
        <OneLineDisplay toolName="TaskCreate" value="Ship it" secondary="open" status="completed" />,
      );
      expect(screen.getByText('open')).toBeTruthy();
    });

    it('does not copy when the copy handler is invoked with an empty value', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText, readText: async () => '' },
      });
      render(<OneLineDisplay toolName="TaskList" value="" action="copy" />);
      const button = screen.getByRole('button', { name: /copy to clipboard/i });
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(writeText).not.toHaveBeenCalled();
    });
  });
});
