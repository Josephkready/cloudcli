import { act, renderHook } from '@testing-library/react';
import type { FormEvent, MutableRefObject } from 'react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';

import { useComposerCommands } from './useComposerCommands';
import type { SlashCommand } from './useSlashCommands';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));

const project: Project = {
  projectId: 'project-1',
  displayName: 'Demo',
  path: '/workspace/demo',
  fullPath: '/workspace/demo',
} as Project;

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function setup() {
  const setInput = vi.fn();
  const inputValueRef = { current: '' };
  const addMessage = vi.fn();
  const onShowSettings = vi.fn();

  const { result } = renderHook(() => {
    const handleSubmitRef = useRef<((event: FormEvent<HTMLFormElement>) => Promise<boolean>) | null>(
      vi.fn(async () => true),
    ) as MutableRefObject<((event: FormEvent<HTMLFormElement>) => Promise<boolean>) | null>;
    const hook = useComposerCommands({
      selectedProject: project,
      currentSessionId: 'session-1',
      provider: 'claude',
      claudeModel: 'claude-test',
      codexModel: 'gpt-test',
      antigravityModel: 'gemini-test',
      tokenBudget: null,
      input: '/cost',
      setInput,
      inputValueRef,
      handleSubmitRef,
      addMessage,
      onShowSettings,
    });
    return { hook, handleSubmitRef };
  });

  return { result, setInput, inputValueRef, addMessage, onShowSettings };
}

const costCommand = { name: '/cost', description: 'cost', namespace: 'builtin' } as SlashCommand;

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
});

describe('useComposerCommands — built-in commands', () => {
  it('opens the cost modal with the server-provided data on a built-in cost command', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      jsonResponse({ type: 'builtin', action: 'cost', data: { provider: 'claude', model: 'claude-test' } }),
    );
    const { result } = setup();

    await act(async () => {
      await result.current.hook.executeCommand(costCommand);
    });

    expect(result.current.hook.commandModalPayload).toEqual({
      kind: 'cost',
      data: { provider: 'claude', model: 'claude-test' },
    });
  });

  it('clears the input after a built-in command unless preserveInput is set', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      jsonResponse({ type: 'builtin', action: 'cost', data: {} }),
    );
    const { result, setInput, inputValueRef } = setup();

    await act(async () => {
      await result.current.hook.executeCommand(costCommand);
    });

    expect(setInput).toHaveBeenCalledWith('');
    expect(inputValueRef.current).toBe('');
  });

  it('leaves the input alone when preserveInput is requested (e.g. showCostModal)', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      jsonResponse({ type: 'builtin', action: 'cost', data: {} }),
    );
    const { result, setInput } = setup();

    await act(async () => {
      await result.current.hook.showCostModal();
    });

    expect(setInput).not.toHaveBeenCalled();
    expect(authenticatedFetch).toHaveBeenCalledWith(
      '/api/commands/execute',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"commandName":"/cost"'),
      }),
    );
  });

  it('closeCommandModal clears the modal payload', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      jsonResponse({ type: 'builtin', action: 'cost', data: {} }),
    );
    const { result } = setup();
    await act(async () => {
      await result.current.hook.executeCommand(costCommand);
    });
    expect(result.current.hook.commandModalPayload).not.toBeNull();

    act(() => {
      result.current.hook.closeCommandModal();
    });

    expect(result.current.hook.commandModalPayload).toBeNull();
  });
});

describe('useComposerCommands — custom commands', () => {
  it('fills the input with the returned content and replays a submit for a custom command', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      jsonResponse({ type: 'custom', content: 'expanded prompt text' }),
    );
    const { result, setInput, inputValueRef } = setup();
    vi.useFakeTimers();

    await act(async () => {
      await result.current.hook.executeCommand(
        { name: '/mycmd', description: '', namespace: 'project' } as SlashCommand,
      );
    });

    expect(setInput).toHaveBeenCalledWith('expanded prompt text');
    expect(inputValueRef.current).toBe('expanded prompt text');

    const submitFn = result.current.handleSubmitRef.current;
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    expect(submitFn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('useComposerCommands — errors and edge cases', () => {
  it('reports a chat message when the server returns a non-ok response', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(jsonResponse({ message: 'boom' }, false));
    const { result, addMessage } = setup();

    await act(async () => {
      await result.current.hook.executeCommand(costCommand);
    });

    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        content: expect.stringContaining('boom'),
      }),
    );
  });

  it('does nothing when there is no selected project', async () => {
    const { result } = renderHook(() => {
      const handleSubmitRef = useRef<((event: FormEvent<HTMLFormElement>) => Promise<boolean>) | null>(null);
      return useComposerCommands({
        selectedProject: null,
        currentSessionId: null,
        provider: 'claude',
        claudeModel: 'claude-test',
        codexModel: 'gpt-test',
        antigravityModel: 'gemini-test',
        tokenBudget: null,
        input: '/cost',
        setInput: vi.fn(),
        inputValueRef: { current: '' },
        handleSubmitRef,
        addMessage: vi.fn(),
      });
    });

    await act(async () => {
      await result.current.executeCommand(costCommand);
    });

    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(result.current.commandModalPayload).toBeNull();
  });
});
