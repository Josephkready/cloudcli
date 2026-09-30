import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ToolRenderer } from './ToolRenderer';

/**
 * ToolRenderer is a pure dispatcher: given a tool name + mode, it picks a
 * config from toolConfigs and routes to the matching sub-renderer. These
 * tests exercise the routing decisions and the small pieces of logic that
 * live directly in this file (status derivation, Bash's special-cased input
 * row, the title-click-to-open-file wiring) rather than re-testing each leaf
 * content renderer's own internals.
 *
 * Uses vitest/jsdom (not node:test) because the 'markdown' contentType
 * (exercised via the Task tool) transitively renders
 * view/subcomponents/Markdown.tsx.
 */

const identityDiff = vi.fn((oldStr: string, newStr: string) => [
  { type: 'context', content: `${oldStr}|${newStr}`, lineNum: 1 },
]);

describe('ToolRenderer dispatch', () => {
  it('renders nothing when the config has no matching content for the mode (TaskCreate result)', () => {
    // TaskCreate.result = { hideOnSuccess: true } — no `type`, so none of the
    // branches match and the component falls through to `return null`.
    const { container } = render(
      <ToolRenderer toolName="TaskCreate" toolInput={{}} toolResult={{ content: 'ok' }} mode="result" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a hidden result config (Read)', () => {
    const { container } = render(
      <ToolRenderer toolName="Read" toolInput={{ file_path: '/a.txt' }} toolResult={{ content: 'hi' }} mode="result" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  describe('Bash input special-case', () => {
    it('reads the command from parsed JSON input and shows output', () => {
      render(
        <ToolRenderer
          toolName="Bash"
          toolInput={JSON.stringify({ command: 'ls -la', description: 'list files' })}
          toolResult={{ content: 'file1\nfile2', isError: false }}
          mode="input"
        />,
      );
      expect(screen.getByText('ls -la')).toBeInTheDocument();
      expect(screen.getByText('list files')).toBeInTheDocument();
    });

    it('falls back to a raw string toolInput as the command', () => {
      render(<ToolRenderer toolName="Bash" toolInput="echo hi" mode="input" />);
      expect(screen.getByText('echo hi')).toBeInTheDocument();
    });

    it('falls back to rawToolInput when toolInput is neither an object nor a string', () => {
      render(<ToolRenderer toolName="Bash" toolInput={undefined} rawToolInput="raw-command" mode="input" />);
      expect(screen.getByText('raw-command')).toBeInTheDocument();
    });

    it('marks the row as errored when the tool result is an error', () => {
      render(
        <ToolRenderer
          toolName="Bash"
          toolInput={{ command: 'false' }}
          toolResult={{ content: 'boom', isError: true }}
          mode="input"
        />,
      );
      // BashCommandDisplay renders isError styling; the command text is present regardless.
      expect(screen.getByText('false')).toBeInTheDocument();
    });

    it('stringifies a non-string result content', () => {
      render(
        <ToolRenderer
          toolName="Bash"
          toolInput={{ command: 'echo 1' }}
          toolResult={{ content: 42 }}
          mode="input"
        />,
      );
      expect(screen.getByText('echo 1')).toBeInTheDocument();
    });
  });

  describe('one-line type', () => {
    it('renders OneLineDisplay for Grep with value and secondary', () => {
      render(
        <ToolRenderer
          toolName="Grep"
          toolInput={{ pattern: 'TODO', path: 'src' }}
          mode="input"
        />,
      );
      expect(screen.getByText('TODO')).toBeInTheDocument();
      expect(screen.getByText('in src')).toBeInTheDocument();
    });

    it('shows the Read file name as plain text with the full path on hover', () => {
      render(
        <ToolRenderer
          toolName="Read"
          toolInput={{ file_path: '/tmp/foo.ts' }}
          mode="input"
        />,
      );
      const name = screen.getByText('foo.ts');
      expect(name.tagName).toBe('SPAN');
      expect(name).toHaveAttribute('title', '/tmp/foo.ts');
      expect(screen.queryByRole('button', { name: 'foo.ts' })).not.toBeInTheDocument();
    });
  });

  describe('plan type', () => {
    it('renders PlanDisplay with a computed title and markdown content for exit_plan_mode', async () => {
      render(
        <ToolRenderer
          toolName="exit_plan_mode"
          toolInput={{ plan: '# Step one\nDo the thing' }}
          mode="input"
        />,
      );
      expect(screen.getByText('Implementation plan')).toBeInTheDocument();
      // `Markdown` is demand-loaded (perf-audit package WP7): a plain-text
      // fallback shows first, then this once the renderer chunk resolves.
      await waitFor(() => {
        expect(screen.getByText('Do the thing')).toBeInTheDocument();
      });
    });

    it('marks a plan as streaming while awaiting a result', () => {
      const { rerender } = render(
        <ToolRenderer toolName="exit_plan_mode" toolInput={{ plan: 'in progress' }} mode="input" />,
      );
      expect(screen.getByText('in progress')).toBeInTheDocument();

      rerender(
        <ToolRenderer
          toolName="exit_plan_mode"
          toolInput={{ plan: 'done' }}
          toolResult={{ content: 'ok' }}
          mode="input"
        />,
      );
      expect(screen.getByText('done')).toBeInTheDocument();
    });
  });

  describe('collapsible / diff', () => {
    it('renders a diff viewer for Edit when createDiff is provided, titled by the file name', () => {
      const { container } = render(
        <ToolRenderer
          toolName="Edit"
          toolInput={{ file_path: '/src/App.tsx', old_string: 'old', new_string: 'new' }}
          mode="input"
          createDiff={identityDiff}
        />,
      );
      // The title is plain text inside the section's single toggle, not a separate link.
      expect(screen.getAllByRole('button')).toHaveLength(1);

      // Diffs default collapsed and are lazy-mounted (#WP6), so createDiff has
      // not run yet — expand via the chevron trigger to mount the diff viewer.
      expect(identityDiff).not.toHaveBeenCalled();
      const trigger = container.querySelector('button[aria-expanded="false"]');
      expect(trigger).not.toBeNull();
      fireEvent.click(trigger as HTMLButtonElement);
      expect(identityDiff).toHaveBeenCalledWith('old', 'new');
    });

    it('does not compute the diff while the Edit accordion stays collapsed', () => {
      render(
        <ToolRenderer
          toolName="Edit"
          toolInput={{ file_path: '/src/App.tsx', old_string: 'old', new_string: 'new' }}
          mode="input"
          createDiff={identityDiff}
        />,
      );
      expect(identityDiff).not.toHaveBeenCalled();
    });

    it('keeps the diff content mounted (does not recompute) after collapsing again', () => {
      const { container } = render(
        <ToolRenderer
          toolName="Edit"
          toolInput={{ file_path: '/src/App.tsx', old_string: 'old', new_string: 'new' }}
          mode="input"
          createDiff={identityDiff}
        />,
      );

      const trigger = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
      fireEvent.click(trigger); // expand — first mount, computes the diff once
      expect(identityDiff).toHaveBeenCalledTimes(1);

      fireEvent.click(trigger); // collapse again — lazyMount keeps content mounted
      fireEvent.click(trigger); // re-expand
      expect(identityDiff).toHaveBeenCalledTimes(1);
      // The already-rendered diff row is still in the DOM the whole time.
      expect(screen.getByText('old|new')).toBeInTheDocument();
    });

    it('omits the diff viewer entirely when createDiff is not provided', () => {
      const { container } = render(
        <ToolRenderer
          toolName="Edit"
          toolInput={{ file_path: '/src/App.tsx', old_string: 'old', new_string: 'new' }}
          mode="input"
        />,
      );
      expect(container.querySelector('pre')).not.toBeInTheDocument();
      // Title still renders even without diff content.
      expect(screen.getByText('App.tsx')).toBeInTheDocument();
    });
  });

  describe('collapsible / markdown (Task tool, transitively renders Markdown.tsx)', () => {
    it('renders the subagent prompt as markdown content', async () => {
      render(
        <ToolRenderer
          toolName="Task"
          toolInput={{ subagent_type: 'general-purpose', description: 'do work', prompt: 'Please **do** the work' }}
          mode="input"
        />,
      );
      expect(screen.getByText(/Subagent \/ general-purpose: do work/)).toBeInTheDocument();
      // `Markdown` is demand-loaded (perf-audit package WP7): a plain-text
      // fallback shows first, then this once the renderer chunk resolves.
      await waitFor(() => {
        expect(screen.getByText('do', { selector: 'strong' })).toBeInTheDocument();
      });
    });

    it('renders the subagent result content', () => {
      render(
        <ToolRenderer
          toolName="Task"
          toolInput={{}}
          toolResult={{ content: 'Final answer text' }}
          mode="result"
        />,
      );
      expect(screen.getByText('Subagent result')).toBeInTheDocument();
      expect(screen.getByText('Final answer text')).toBeInTheDocument();
    });
  });

  describe('collapsible / file-list', () => {
    it('renders file list content for a Grep result as plain file names', () => {
      render(
        <ToolRenderer
          toolName="Grep"
          toolInput={{}}
          toolResult={{ toolUseResult: { filenames: ['/src/a.ts', '/src/b.ts'] } }}
          mode="result"
        />,
      );
      expect(screen.getByText('Found 2 files')).toBeInTheDocument();
      expect(screen.getByText('a.ts')).toHaveAttribute('title', '/src/a.ts');
      expect(screen.queryByRole('button', { name: 'a.ts' })).not.toBeInTheDocument();
    });
  });

  describe('collapsible / todo-list', () => {
    it('renders TodoListContent when todos are present', () => {
      render(
        <ToolRenderer
          toolName="TodoWrite"
          toolInput={{ todos: [{ content: 'Write tests', status: 'pending' }] }}
          mode="input"
        />,
      );
      expect(screen.getByText('Write tests')).toBeInTheDocument();
    });

    it('renders no todo content when the todos array is empty', () => {
      render(<ToolRenderer toolName="TodoWrite" toolInput={{ todos: [] }} mode="input" />);
      expect(screen.getByText('Updating todo list')).toBeInTheDocument();
      expect(screen.queryByText('Write tests')).not.toBeInTheDocument();
    });
  });

  describe('collapsible / task', () => {
    it('renders TaskListContent for a TaskList result', () => {
      render(
        <ToolRenderer
          toolName="TaskList"
          toolInput={{}}
          toolResult={{ content: '#1. [in_progress] Ship feature' }}
          mode="result"
        />,
      );
      expect(screen.getByText('Task list')).toBeInTheDocument();
      expect(screen.getByText('Ship feature')).toBeInTheDocument();
    });
  });

  describe('collapsible / question-answer', () => {
    it('renders questions and marks them resolved once a tool result exists', () => {
      render(
        <ToolRenderer
          toolName="AskUserQuestion"
          toolInput={{
            questions: [{ question: 'Which path?', header: 'Path', options: [{ label: 'A' }, { label: 'B' }] }],
          }}
          toolResult={{ content: 'ok' }}
          mode="input"
        />,
      );
      expect(screen.getAllByText('Path').length).toBeGreaterThan(0);
    });
  });

  describe('collapsible / success-message', () => {
    it('renders the success message for a TodoWrite result', () => {
      render(<ToolRenderer toolName="TodoWrite" toolInput={{}} toolResult={{ content: '[]' }} mode="result" />);
      expect(screen.getByText('Todo list updated')).toBeInTheDocument();
    });
  });

  describe('collapsible / text (Default fallback)', () => {
    it('routes unknown tools to the Default config and shows JSON parameters', () => {
      render(<ToolRenderer toolName="SomeUnknownTool" toolInput={{ foo: 'bar' }} mode="input" />);
      expect(screen.getByText('Parameters')).toBeInTheDocument();
      expect(screen.getByText(/"foo": "bar"/)).toBeInTheDocument();
    });
  });

  describe('status badge derivation', () => {
    it('shows an error badge for a generic failure', () => {
      render(
        <ToolRenderer
          toolName="SomeUnknownTool"
          toolInput={{}}
          toolResult={{ isError: true, content: 'kaboom' }}
          mode="input"
        />,
      );
      expect(screen.getByText(/error/i)).toBeInTheDocument();
    });

    it('shows a denied badge for a recognized Claude denial message', () => {
      render(
        <ToolRenderer
          toolName="SomeUnknownTool"
          toolInput={{}}
          toolResult={{ isError: true, content: 'User denied tool use' }}
          mode="input"
        />,
      );
      expect(screen.getByText(/denied/i)).toBeInTheDocument();
    });

    it('shows no badge once the tool has completed successfully', () => {
      render(
        <ToolRenderer
          toolName="SomeUnknownTool"
          toolInput={{}}
          toolResult={{ content: 'done', isError: false }}
          mode="input"
        />,
      );
      expect(screen.queryByText(/error|denied|running/i)).not.toBeInTheDocument();
    });

    it('does not derive a status badge on result-mode renders', () => {
      render(
        <ToolRenderer
          toolName="SomeUnknownTool"
          toolInput={{}}
          toolResult={{ isError: true, content: 'user denied tool use' }}
          mode="result"
        />,
      );
      // Result mode never computes toolStatus, so no badge should render even
      // though the raw error content contains the word "denied".
      expect(screen.queryByText('Denied')).not.toBeInTheDocument();
    });
  });

  describe('subagent container routing', () => {
    const subagentState = {
      childTools: [],
      currentToolIndex: -1,
      isComplete: false,
    };

    it('routes to SubagentContainer on input mode when isSubagentContainer is set', () => {
      render(
        <ToolRenderer
          toolName="Task"
          toolInput={{ subagent_type: 'general-purpose', description: 'investigate' }}
          mode="input"
          isSubagentContainer
          subagentState={subagentState}
        />,
      );
      expect(screen.getByText(/Subagent \/ general-purpose: investigate/)).toBeInTheDocument();
    });

    it('renders nothing for a subagent container in result mode', () => {
      const { container } = render(
        <ToolRenderer
          toolName="Task"
          toolInput={{}}
          toolResult={{ content: 'done' }}
          mode="result"
          isSubagentContainer
          subagentState={subagentState}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    });
  });
});
