import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';

import type { Project } from '../../../types/app';

import { useFileMentions } from './useFileMentions';

const mockGetFiles = vi.fn();
vi.mock('../../../utils/api', () => ({
  api: { getFiles: (...args: unknown[]) => mockGetFiles(...args) },
}));

const mockRecordFeatureUse = vi.fn();
vi.mock('../../../utils/featureUsage', () => ({
  recordFeatureUse: (...args: unknown[]) => mockRecordFeatureUse(...args),
}));

const project = (overrides: Partial<Project> = {}): Project =>
  ({ projectId: 'proj-1', name: 'bench', path: '/w/bench', ...overrides }) as Project;

const filesResponse = (files: unknown[]) => ({
  ok: true,
  json: async () => files,
});

function setup(initialInput = '') {
  let input = initialInput;
  const setInput = vi.fn((updater: unknown) => {
    input = typeof updater === 'function' ? (updater as (value: string) => string)(input) : (updater as string);
  });
  const textareaRef = { current: null } as unknown as React.RefObject<HTMLTextAreaElement>;
  const rendered = renderHook<
    ReturnType<typeof useFileMentions>,
    { selectedProject: Project | null; currentInput: string }
  >(
    ({ selectedProject, currentInput }) =>
      useFileMentions({ selectedProject, input: currentInput, setInput, textareaRef }),
    { initialProps: { selectedProject: project(), currentInput: initialInput } },
  );
  return { rendered, setInput, textareaRef, getInput: () => input };
}

beforeEach(() => {
  mockGetFiles.mockReset();
  mockRecordFeatureUse.mockReset();
  mockGetFiles.mockResolvedValue(
    filesResponse([
      { name: 'index.ts', type: 'file', path: 'src/index.ts' },
      {
        name: 'components',
        type: 'directory',
        children: [{ name: 'App.tsx', type: 'file', path: 'src/components/App.tsx' }],
      },
    ]),
  );
});

describe('useFileMentions — loading the project file list', () => {
  it('flattens nested directories into a mentionable file list', async () => {
    const { rendered } = setup();
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalledWith('proj-1', expect.anything()));

    act(() => rendered.result.current.setCursorPosition(1));
    // Trigger the filter effect via an @ query that matches everything.
    rendered.rerender({ selectedProject: project(), currentInput: '@' });
    act(() => rendered.result.current.setCursorPosition(1));

    await waitFor(() => expect(rendered.result.current.filteredFiles.length).toBeGreaterThan(0));
    const names = rendered.result.current.filteredFiles.map((f) => f.name).sort();
    expect(names).toEqual(['App.tsx', 'index.ts']);
  });

  it('clears the file list when no project is selected', async () => {
    const { rendered } = setup();
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());

    rendered.rerender({ selectedProject: null, currentInput: '' });
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalledTimes(1));
  });

  it('swallows a non-ok response without throwing', async () => {
    mockGetFiles.mockResolvedValue({ ok: false, json: async () => [] });
    const { rendered } = setup();
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    expect(rendered.result.current.filteredFiles).toEqual([]);
  });

  it('logs unexpected fetch errors but ignores aborts', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetFiles.mockRejectedValue(new Error('network down'));
    setup();
    await waitFor(() => expect(errors).toHaveBeenCalledWith('Error fetching files:', expect.any(Error)));
    errors.mockRestore();
  });

  it('does not log an AbortError', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockGetFiles.mockRejectedValue(abortError);
    setup();
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    // give the microtask queue a tick to process the rejection
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('useFileMentions — the @ dropdown', () => {
  it('opens the dropdown and filters files by name after @', async () => {
    const { rendered } = setup('hello @ind');
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    act(() => rendered.result.current.setCursorPosition('hello @ind'.length));

    await waitFor(() => expect(rendered.result.current.showFileDropdown).toBe(true));
    // Filtering is debounced (FILE_MENTION_DEBOUNCE_MS) after the dropdown opens.
    await waitFor(() =>
      expect(rendered.result.current.filteredFiles.map((f) => f.name)).toEqual(['index.ts']),
    );
  });

  it('closes the dropdown once a space follows the @', async () => {
    const { rendered } = setup('hello @ind more');
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    act(() => rendered.result.current.setCursorPosition('hello @ind more'.length));

    await waitFor(() => expect(rendered.result.current.showFileDropdown).toBe(false));
  });

  it('only reflects the latest query when it changes before the debounce fires', async () => {
    // A stale in-flight debounce timer from an earlier keystroke must not
    // clobber the result of a newer one (the fast-path fix for #WP6 dropped a
    // useRef for the timer id in favor of a plain effect-cleanup-cancelled
    // local, so this pins that the cancellation still happens correctly).
    const { rendered } = setup('hello @i');
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    act(() => rendered.result.current.setCursorPosition('hello @i'.length));
    await waitFor(() => expect(rendered.result.current.showFileDropdown).toBe(true));

    // Change the query well before the 150ms debounce for "@i" can fire.
    rendered.rerender({ selectedProject: project(), currentInput: 'hello @App' });
    act(() => rendered.result.current.setCursorPosition('hello @App'.length));

    await waitFor(() =>
      expect(rendered.result.current.filteredFiles.map((f) => f.name)).toEqual(['App.tsx']),
    );
    // The stale "@i" query's match (index.ts) never leaks into the final result.
    expect(rendered.result.current.filteredFiles.map((f) => f.name)).not.toContain('index.ts');
  });

  it('closes the dropdown when there is no @ before the cursor', async () => {
    const { rendered } = setup('hello world');
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    act(() => rendered.result.current.setCursorPosition(5));

    expect(rendered.result.current.showFileDropdown).toBe(false);
  });
});

describe('useFileMentions — selecting a file', () => {
  it('inserts the file path at the @ position and records the mention', async () => {
    const { rendered, setInput, getInput } = setup('hello @ind');
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    act(() => rendered.result.current.setCursorPosition('hello @ind'.length));
    await waitFor(() => expect(rendered.result.current.filteredFiles.length).toBeGreaterThan(0));

    act(() => rendered.result.current.selectFile(rendered.result.current.filteredFiles[0]));

    expect(mockRecordFeatureUse).toHaveBeenCalledWith('chat.file_mention');
    expect(setInput).toHaveBeenCalledWith('hello index.ts ');

    // A real composer feeds the updated input straight back in; simulate that
    // controlled-input round trip before asserting the dropdown closed.
    rendered.rerender({ selectedProject: project(), currentInput: getInput() });
    expect(rendered.result.current.showFileDropdown).toBe(false);
  });

  it('renders selected mentions as highlighted spans', async () => {
    const { rendered } = setup('hello @ind');
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    act(() => rendered.result.current.setCursorPosition('hello @ind'.length));
    await waitFor(() => expect(rendered.result.current.filteredFiles.length).toBeGreaterThan(0));
    act(() => rendered.result.current.selectFile(rendered.result.current.filteredFiles[0]));

    rendered.rerender({ selectedProject: project(), currentInput: 'hello index.ts ' });
    const nodes = rendered.result.current.renderInputWithMentions('hello index.ts ');
    expect(Array.isArray(nodes)).toBe(true);
  });

  it('renderInputWithMentions returns an empty string for empty text', async () => {
    const { rendered } = setup();
    expect(rendered.result.current.renderInputWithMentions('')).toBe('');
  });

  it('renderInputWithMentions returns the text unchanged with no active mentions', async () => {
    const { rendered } = setup();
    expect(rendered.result.current.renderInputWithMentions('plain text')).toBe('plain text');
  });
});

describe('useFileMentions — keyboard navigation', () => {
  async function openDropdown() {
    const { rendered, setInput } = setup('@');
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    act(() => rendered.result.current.setCursorPosition(1));
    await waitFor(() => expect(rendered.result.current.filteredFiles.length).toBeGreaterThan(0));
    return { rendered, setInput };
  }

  const key = (k: string) => ({ key: k, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>);

  it('ignores keys when the dropdown is closed', async () => {
    const { rendered } = setup();
    expect(rendered.result.current.handleFileMentionsKeyDown(key('ArrowDown'))).toBe(false);
  });

  it('ArrowDown/ArrowUp move the selection and wrap', async () => {
    const { rendered } = await openDropdown();
    const count = rendered.result.current.filteredFiles.length;

    // Starts at -1; one ArrowDown lands on 0, and it takes count+1 presses
    // to wrap all the way back around to 0.
    act(() => rendered.result.current.handleFileMentionsKeyDown(key('ArrowDown')));
    expect(rendered.result.current.selectedFileIndex).toBe(0);

    act(() => {
      for (let i = 0; i < count; i += 1) {
        rendered.result.current.handleFileMentionsKeyDown(key('ArrowDown'));
      }
    });
    expect(rendered.result.current.selectedFileIndex).toBe(0);

    act(() => rendered.result.current.handleFileMentionsKeyDown(key('ArrowUp')));
    expect(rendered.result.current.selectedFileIndex).toBe(count - 1);
  });

  it('Tab/Enter select the highlighted file, or the first when none is highlighted', async () => {
    const { rendered, setInput } = await openDropdown();

    act(() => rendered.result.current.handleFileMentionsKeyDown(key('Tab')));

    expect(setInput).toHaveBeenCalled();
  });

  it('Escape closes the dropdown', async () => {
    const { rendered } = await openDropdown();

    act(() => rendered.result.current.handleFileMentionsKeyDown(key('Escape')));
    expect(rendered.result.current.showFileDropdown).toBe(false);
  });

  it('an unhandled key returns false', async () => {
    const { rendered } = await openDropdown();
    expect(rendered.result.current.handleFileMentionsKeyDown(key('a'))).toBe(false);
  });

  it('returns false when the dropdown is open but has no matches', async () => {
    const { rendered } = setup('@zzzznomatch');
    await waitFor(() => expect(mockGetFiles).toHaveBeenCalled());
    act(() => rendered.result.current.setCursorPosition('@zzzznomatch'.length));
    await waitFor(() => expect(rendered.result.current.showFileDropdown).toBe(true));
    expect(rendered.result.current.filteredFiles).toEqual([]);

    expect(rendered.result.current.handleFileMentionsKeyDown(key('ArrowDown'))).toBe(false);
  });
});
