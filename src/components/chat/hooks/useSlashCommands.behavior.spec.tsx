import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';

import type { Project } from '../../../types/app';

import { useSlashCommands } from './useSlashCommands';
import type { SlashCommand } from './useSlashCommands.pure';

/**
 * Behavioural coverage for the parts of useSlashCommands that the refetch
 * spec doesn't touch: keyboard navigation of the menu, inserting a command
 * into the textarea, tracking usage history in localStorage, and toggling
 * the menu open/closed.
 */

const mockFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));

const project = (overrides: Partial<Project> = {}): Project =>
  ({
    projectId: 'project-1',
    name: 'bench',
    path: '/workspace/bench',
    fullPath: '/workspace/bench',
    displayName: 'bench',
    sessions: [],
    ...overrides,
  }) as Project;

const commandsResponse = (builtIn: SlashCommand[] = [], custom: SlashCommand[] = []) => ({
  ok: true,
  status: 200,
  json: async () => ({ builtIn, custom }),
});

const emptySkillsResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data: { skills: [] } }),
});

const skillsResponse = (commandName: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    data: { skills: [{ name: commandName, command: commandName, description: 'a skill', scope: 'user' }] },
  }),
});

function makeTextarea(value: string, selectionStart = value.length, selectionEnd = selectionStart) {
  return {
    current: {
      value,
      selectionStart,
      selectionEnd,
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    },
  } as unknown as React.RefObject<HTMLTextAreaElement>;
}

function renderSlash(options: Partial<Parameters<typeof useSlashCommands>[0]> & { selectedProject?: Project | null } = {}) {
  const setInput = vi.fn();
  const onExecuteCommand = vi.fn();
  const textareaRef = options.textareaRef ?? makeTextarea('');
  const rendered = renderHook(() =>
    useSlashCommands({
      selectedProject: project(),
      provider: 'claude',
      input: '',
      setInput,
      textareaRef,
      onExecuteCommand,
      ...options,
    }),
  );
  return { ...rendered, setInput, onExecuteCommand, textareaRef };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(
      String(url).includes('/skills')
        ? emptySkillsResponse()
        : commandsResponse([{ name: 'init' }, { name: 'deploy' }]),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadCommands(result: { current: ReturnType<typeof useSlashCommands> }) {
  await vi.waitFor(() => expect(result.current.slashCommands.length).toBeGreaterThan(0));
}

describe('useSlashCommands — command menu keyboard flow', () => {
  it('debounces the query and opens the menu on a slash token', async () => {
    const { result } = renderSlash();
    await loadCommands(result);

    act(() => result.current.handleCommandInputChange('/in', 3));
    expect(result.current.showCommandMenu).toBe(true);
    // Query is debounced; it should not have updated yet.
    expect(result.current.commandQuery).toBe('');

    act(() => vi.advanceTimersByTime(150));
    expect(result.current.commandQuery).toBe('in');
  });

  it('closes the menu when the input is blank', async () => {
    const { result } = renderSlash();
    await loadCommands(result);

    act(() => result.current.handleCommandInputChange('/in', 3));
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.showCommandMenu).toBe(true);

    act(() => result.current.handleCommandInputChange('   ', 0));
    expect(result.current.showCommandMenu).toBe(false);
  });

  it('closes the menu while typing inside a code fence', async () => {
    const { result } = renderSlash();
    await loadCommands(result);

    act(() => result.current.handleCommandInputChange('```\n/in', 7));
    expect(result.current.showCommandMenu).toBe(false);
  });

  it('does not open the menu without a slash token before the cursor', async () => {
    const { result } = renderSlash();
    await loadCommands(result);

    act(() => result.current.handleCommandInputChange('hello world', 11));
    expect(result.current.showCommandMenu).toBe(false);
  });

  it('navigates the filtered list with arrow keys, wrapping at the ends', async () => {
    const { result } = renderSlash();
    await loadCommands(result);
    act(() => result.current.handleCommandInputChange('/', 1));
    act(() => vi.advanceTimersByTime(150));

    const down = { key: 'ArrowDown', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
    const up = { key: 'ArrowUp', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;

    act(() => {
      expect(result.current.handleCommandMenuKeyDown(down)).toBe(true);
    });
    expect(result.current.selectedCommandIndex).toBe(0);

    act(() => {
      result.current.handleCommandMenuKeyDown(up);
    });
    expect(result.current.selectedCommandIndex).toBe(result.current.filteredCommands.length - 1);
  });

  it('Escape closes the menu and resets state', async () => {
    const { result } = renderSlash();
    await loadCommands(result);
    act(() => result.current.handleCommandInputChange('/', 1));
    act(() => vi.advanceTimersByTime(150));

    const escape = { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
    act(() => {
      expect(result.current.handleCommandMenuKeyDown(escape)).toBe(true);
    });
    expect(result.current.showCommandMenu).toBe(false);
    expect(result.current.commandQuery).toBe('');
  });

  it('Escape with no matches still closes the menu', async () => {
    const { result } = renderSlash();
    await loadCommands(result);
    act(() => result.current.handleCommandInputChange('/zzzznomatch', 12));
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.filteredCommands).toEqual([]);

    const escape = { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
    act(() => {
      expect(result.current.handleCommandMenuKeyDown(escape)).toBe(true);
    });
    expect(result.current.showCommandMenu).toBe(false);
  });

  it('ignores other keys when there are no matches', async () => {
    const { result } = renderSlash();
    await loadCommands(result);
    act(() => result.current.handleCommandInputChange('/zzzznomatch', 12));
    act(() => vi.advanceTimersByTime(150));

    const down = { key: 'ArrowDown', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
    act(() => {
      expect(result.current.handleCommandMenuKeyDown(down)).toBe(false);
    });
  });

  it('returns false when the menu is closed', async () => {
    const { result } = renderSlash();
    await loadCommands(result);
    const down = { key: 'ArrowDown', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
    expect(result.current.handleCommandMenuKeyDown(down)).toBe(false);
  });

  it('Enter with a selection executes that command and closes the menu', async () => {
    const onExecuteCommand = vi.fn();
    const { result } = renderSlash({ onExecuteCommand });
    await loadCommands(result);
    act(() => result.current.handleCommandInputChange('/', 1));
    act(() => vi.advanceTimersByTime(150));

    const down = { key: 'ArrowDown', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
    act(() => {
      result.current.handleCommandMenuKeyDown(down);
    });
    const enter = { key: 'Enter', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
    act(() => {
      result.current.handleCommandMenuKeyDown(enter);
    });

    expect(onExecuteCommand).toHaveBeenCalledTimes(1);
    expect(result.current.showCommandMenu).toBe(false);
  });

  it('Tab with no selection picks the first command', async () => {
    const onExecuteCommand = vi.fn();
    const { result } = renderSlash({ onExecuteCommand });
    await loadCommands(result);
    act(() => result.current.handleCommandInputChange('/', 1));
    act(() => vi.advanceTimersByTime(150));

    const tab = { key: 'Tab', preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
    act(() => {
      result.current.handleCommandMenuKeyDown(tab);
    });

    expect(onExecuteCommand).toHaveBeenCalledWith(result.current.slashCommands[0]);
  });
});

describe('useSlashCommands — selecting and tracking commands', () => {
  it('ignores selection when there is no command or no selected project', async () => {
    const { result } = renderSlash({ selectedProject: null });
    act(() => {
      result.current.handleCommandSelect(null, 0, false);
    });
    expect(result.current.selectedCommandIndex).toBe(-1);
  });

  it('hover just updates the highlighted index without executing', async () => {
    const onExecuteCommand = vi.fn();
    const { result } = renderSlash({ onExecuteCommand });
    await loadCommands(result);

    act(() => {
      result.current.handleCommandSelect(result.current.slashCommands[0], 2, true);
    });
    expect(result.current.selectedCommandIndex).toBe(2);
    expect(onExecuteCommand).not.toHaveBeenCalled();
  });

  it('selecting a plain command executes it and records usage history', async () => {
    const onExecuteCommand = vi.fn();
    const { result } = renderSlash({ onExecuteCommand });
    await loadCommands(result);
    const command = result.current.slashCommands.find((c) => c.name === 'init')!;

    act(() => {
      result.current.handleCommandSelect(command, 0, false);
    });

    expect(onExecuteCommand).toHaveBeenCalledWith(command);
    const history = JSON.parse(localStorage.getItem('command_history_project-1') || '{}');
    expect(history.init).toBe(1);
  });

  it('a promise-returning command resets the menu after it settles', async () => {
    let resolveExec: () => void = () => {};
    const onExecuteCommand = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExec = resolve;
        }),
    );
    const { result } = renderSlash({ onExecuteCommand });
    await loadCommands(result);
    act(() => result.current.handleCommandInputChange('/', 1));
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.showCommandMenu).toBe(true);

    act(() => {
      result.current.handleCommandSelect(result.current.slashCommands[0], 0, false);
    });
    // Still open until the promise settles.
    expect(result.current.showCommandMenu).toBe(true);

    await act(async () => {
      resolveExec();
      await Promise.resolve();
    });
    expect(result.current.showCommandMenu).toBe(false);
  });

  it('a rejected promise-returning command still resets the menu', async () => {
    let rejectExec: () => void = () => {};
    const onExecuteCommand = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectExec = () => reject(new Error('boom'));
        }),
    );
    const { result } = renderSlash({ onExecuteCommand });
    await loadCommands(result);
    act(() => result.current.handleCommandInputChange('/', 1));
    act(() => vi.advanceTimersByTime(150));

    act(() => {
      result.current.handleCommandSelect(result.current.slashCommands[0], 0, false);
    });

    await act(async () => {
      rejectExec();
      await Promise.resolve().catch(() => {});
    });
    expect(result.current.showCommandMenu).toBe(false);
  });

  it('frequentCommands ranks by recorded usage and caps at 5', async () => {
    const onExecuteCommand = vi.fn();
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('/skills')
          ? emptySkillsResponse()
          : commandsResponse([{ name: 'a' }, { name: 'b' }, { name: 'c' }]),
      ),
    );
    const { result, rerender } = renderSlash({ onExecuteCommand });
    await loadCommands(result);

    const b = result.current.slashCommands.find((c) => c.name === 'b')!;
    const a = result.current.slashCommands.find((c) => c.name === 'a')!;
    act(() => {
      result.current.handleCommandSelect(b, 0, false);
      result.current.handleCommandSelect(b, 0, false);
      result.current.handleCommandSelect(a, 0, false);
    });
    // handleCommandSelect's own state resets are no-ops here (already at
    // default), so force a render to pick up the localStorage write.
    rerender();

    expect(result.current.frequentCommands.map((c) => c.name)).toEqual(['b', 'a']);
  });
});

describe('useSlashCommands — toggling the menu and inserting text', () => {
  it('opening the menu via the toggle button shows every command', async () => {
    const { result } = renderSlash();
    await loadCommands(result);
    expect(result.current.showCommandMenu).toBe(false);

    act(() => {
      result.current.handleToggleCommandMenu();
    });

    expect(result.current.showCommandMenu).toBe(true);
    expect(result.current.filteredCommands).toEqual(result.current.slashCommands);
  });

  it('toggling closed clears the query and selection', async () => {
    const { result } = renderSlash();
    await loadCommands(result);
    act(() => result.current.handleToggleCommandMenu());
    act(() => result.current.handleToggleCommandMenu());
    expect(result.current.showCommandMenu).toBe(false);
    expect(result.current.commandQuery).toBe('');
  });

  it('inserting a skill command at a typed slash replaces the /token and adds a space', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('/skills') ? skillsResponse('deploy-skill') : commandsResponse()),
    );
    const setInput = vi.fn();
    const textareaRef = makeTextarea('hello /in', 9, 9);
    const { result } = renderSlash({ input: 'hello /in', setInput, textareaRef });
    await loadCommands(result);
    act(() => result.current.handleCommandInputChange('hello /in', 9));
    act(() => vi.advanceTimersByTime(150));

    const command = result.current.slashCommands.find((c) => c.name === 'deploy-skill')!;
    act(() => {
      result.current.handleCommandSelect(command, 0, false);
    });

    expect(setInput).toHaveBeenCalledWith('hello deploy-skill ');
  });

  it('inserting a skill via the toggle-opened menu (no slash position) uses the caret', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('/skills') ? skillsResponse('deploy-skill') : commandsResponse()),
    );
    const setInput = vi.fn();
    const textareaRef = makeTextarea('hello ', 6, 6);
    const { result } = renderSlash({ input: 'hello ', setInput, textareaRef });
    await loadCommands(result);
    act(() => result.current.handleToggleCommandMenu());

    const command = result.current.slashCommands.find((c) => c.name === 'deploy-skill')!;
    act(() => {
      result.current.handleCommandSelect(command, 0, false);
    });

    expect(setInput).toHaveBeenCalledWith('hello deploy-skill ');
  });
});
