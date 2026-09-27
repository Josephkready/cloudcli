import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

import { SubagentContainer } from './SubagentContainer';
import type { SubagentChildTool } from '../../types/types';

/**
 * Uses vitest/jsdom rather than node:test: the collapsible tool-history
 * section and the click-to-expand header rely on real DOM events, and the
 * CollapsibleSection/Collapsible primitives keep their content mounted (just
 * visually collapsed), so assertions here check real rendered text.
 */

function childTool(overrides: Partial<SubagentChildTool>): SubagentChildTool {
  return {
    toolId: 'child-1',
    toolName: 'Read',
    toolInput: {},
    timestamp: new Date(),
    ...overrides,
  };
}

const notComplete = { childTools: [] as SubagentChildTool[], currentToolIndex: -1, isComplete: false };

describe('SubagentContainer', () => {
  it('falls back to defaults when subagent_type/description/prompt are missing', () => {
    render(<SubagentContainer toolInput={{}} subagentState={notComplete} />);
    expect(screen.getByText('Subagent / Agent: Running task')).toBeInTheDocument();
  });

  it('parses a JSON string toolInput and shows the prompt', () => {
    render(
      <SubagentContainer
        toolInput={JSON.stringify({ subagent_type: 'general-purpose', description: 'investigate bug', prompt: 'Look into #123' })}
        subagentState={notComplete}
      />,
    );
    expect(screen.getByText('Subagent / general-purpose: investigate bug')).toBeInTheDocument();
    expect(screen.getByText('Look into #123')).toBeInTheDocument();
  });

  it('falls back to an empty object when toolInput is invalid JSON', () => {
    render(<SubagentContainer toolInput="{not json" subagentState={notComplete} />);
    expect(screen.getByText('Subagent / Agent: Running task')).toBeInTheDocument();
  });

  describe('current tool indicator', () => {
    it('shows the current tool name and compact display while running (Read)', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({ toolName: 'Read', toolInput: { file_path: '/src/app/index.ts' } })],
            currentToolIndex: 0,
            isComplete: false,
          }}
        />,
      );
      expect(screen.getByText('Currently:')).toBeInTheDocument();
      expect(screen.getAllByText('Read').length).toBeGreaterThan(0);
      expect(screen.getAllByText('index.ts').length).toBeGreaterThan(0);
    });

    it('does not show the current tool indicator once complete', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({})],
            currentToolIndex: 0,
            isComplete: true,
          }}
        />,
      );
      expect(screen.queryByText('Currently:')).not.toBeInTheDocument();
    });

    it('shows a Grep pattern for the compact display', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({ toolName: 'Grep', toolInput: { pattern: 'TODO' } })],
            currentToolIndex: 0,
            isComplete: false,
          }}
        />,
      );
      expect(screen.getAllByText('TODO').length).toBeGreaterThan(0);
    });

    it('truncates a long Bash command to 40 chars with an ellipsis', () => {
      const longCmd = 'a'.repeat(50);
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({ toolName: 'Bash', toolInput: { command: longCmd } })],
            currentToolIndex: 0,
            isComplete: false,
          }}
        />,
      );
      expect(screen.getAllByText(`${'a'.repeat(40)}...`).length).toBeGreaterThan(0);
    });

    it('shows a short Bash command untruncated', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({ toolName: 'Bash', toolInput: { command: 'ls -la' } })],
            currentToolIndex: 0,
            isComplete: false,
          }}
        />,
      );
      expect(screen.getAllByText('ls -la').length).toBeGreaterThan(0);
    });

    it('shows a nested Task description or subagent_type', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({ toolName: 'Task', toolInput: { description: 'sub-sub-task' } })],
            currentToolIndex: 0,
            isComplete: false,
          }}
        />,
      );
      expect(screen.getAllByText('sub-sub-task').length).toBeGreaterThan(0);
    });

    it('shows a WebFetch url', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({ toolName: 'WebFetch', toolInput: { url: 'https://example.com' } })],
            currentToolIndex: 0,
            isComplete: false,
          }}
        />,
      );
      expect(screen.getAllByText('https://example.com').length).toBeGreaterThan(0);
    });

    it('parses a JSON string toolInput for the current tool', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({ toolName: 'Grep', toolInput: JSON.stringify({ pattern: 'from-string' }) })],
            currentToolIndex: 0,
            isComplete: false,
          }}
        />,
      );
      expect(screen.getAllByText('from-string').length).toBeGreaterThan(0);
    });

    it('omits the compact display entirely for an unrecognized tool name', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({ toolName: 'MysteryTool', toolInput: { foo: 'bar' } })],
            currentToolIndex: 0,
            isComplete: false,
          }}
        />,
      );
      expect(screen.getAllByText('MysteryTool').length).toBeGreaterThan(0);
      // No trailing "/ value" separator when the compact display is empty.
      expect(screen.queryByText('bar')).not.toBeInTheDocument();
    });
  });

  describe('completion status', () => {
    it('shows singular "tool" for exactly one child tool', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{ childTools: [childTool({})], currentToolIndex: -1, isComplete: true }}
        />,
      );
      expect(screen.getByText('Completed (1 tool)')).toBeInTheDocument();
    });

    it('shows plural "tools" for more than one child tool', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          subagentState={{
            childTools: [childTool({ toolId: '1' }), childTool({ toolId: '2' })],
            currentToolIndex: -1,
            isComplete: true,
          }}
        />,
      );
      expect(screen.getByText('Completed (2 tools)')).toBeInTheDocument();
    });
  });

  describe('tool history', () => {
    it('lists each child tool and expands via the trigger, flagging errored children', () => {
      const tools = [
        childTool({ toolId: '1', toolName: 'Read', toolInput: { file_path: '/a.ts' } }),
        childTool({ toolId: '2', toolName: 'Bash', toolInput: { command: 'false' }, toolResult: { isError: true } }),
      ];
      render(<SubagentContainer toolInput={{}} subagentState={{ childTools: tools, currentToolIndex: -1, isComplete: true }} />);

      const trigger = screen.getByText('View tool history (2)');
      expect(trigger).toBeInTheDocument();
      fireEvent.click(trigger.closest('button')!);

      expect(screen.getByText('a.ts')).toBeInTheDocument();
      expect(screen.getByText('(error)')).toBeInTheDocument();
    });

    it('renders no tool history section when there are no child tools', () => {
      render(<SubagentContainer toolInput={{}} subagentState={notComplete} />);
      expect(screen.queryByText(/View tool history/)).not.toBeInTheDocument();
    });
  });

  describe('final result rendering', () => {
    it('renders plain string content', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          toolResult={{ content: 'Plain final answer' }}
          subagentState={{ childTools: [], currentToolIndex: -1, isComplete: true }}
        />,
      );
      expect(screen.getByText('Plain final answer')).toBeInTheDocument();
    });

    it('extracts text parts from a JSON-string array of {type, text} blocks', () => {
      const content = JSON.stringify([{ type: 'text', text: 'Part one' }, { type: 'text', text: 'Part two' }]);
      const { container } = render(
        <SubagentContainer
          toolInput={{}}
          toolResult={{ content }}
          subagentState={{ childTools: [], currentToolIndex: -1, isComplete: true }}
        />,
      );
      expect(container.querySelector('.line-clamp-6')?.textContent).toBe('Part one\nPart two');
    });

    it('extracts text parts from a direct array content (not JSON-encoded)', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          toolResult={{ content: [{ type: 'text', text: 'Direct array text' }] }}
          subagentState={{ childTools: [], currentToolIndex: -1, isComplete: true }}
        />,
      );
      expect(screen.getByText('Direct array text')).toBeInTheDocument();
    });

    it('falls back to pretty-printed JSON for a non-string, non-array content object', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          toolResult={{ content: { foo: 'bar' } }}
          subagentState={{ childTools: [], currentToolIndex: -1, isComplete: true }}
        />,
      );
      expect(screen.getByText(/"foo": "bar"/)).toBeInTheDocument();
    });

    it('renders nothing for a falsy result content', () => {
      const { container } = render(
        <SubagentContainer
          toolInput={{}}
          toolResult={{ content: '' }}
          subagentState={{ childTools: [], currentToolIndex: -1, isComplete: true }}
        />,
      );
      expect(container.textContent).not.toContain('undefined');
    });

    it('does not render a final result section before completion', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          toolResult={{ content: 'should not show yet' }}
          subagentState={notComplete}
        />,
      );
      expect(screen.queryByText('should not show yet')).not.toBeInTheDocument();
    });

    it('leaves a non-JSON string content as-is', () => {
      render(
        <SubagentContainer
          toolInput={{}}
          toolResult={{ content: 'not [valid json' }}
          subagentState={{ childTools: [], currentToolIndex: -1, isComplete: true }}
        />,
      );
      expect(screen.getByText('not [valid json')).toBeInTheDocument();
    });
  });
});
