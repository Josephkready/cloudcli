import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '../../types/types';

import ChatComposer from './ChatComposer';

/*
 * Mobile permission-mode pill (#239).
 *
 * The label was `hidden sm:inline`, so below 640px — i.e. on every phone — the
 * control collapsed to a bare 10px coloured dot with no text. Permission mode
 * governs whether the agent asks before acting, so `bypassPermissions` could be
 * active with nothing readable to say so, one tap away from cycling again.
 *
 * The pill also carried only a `title`, which does nothing on touch, leaving it
 * with no accessible name at all on exactly the devices that hid the label.
 */

vi.mock('../../hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: vi.fn(), errorMsg: null }),
}));
vi.mock('../../hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));

function renderComposer(permissionMode: PermissionMode) {
  const noop = vi.fn();
  return render(
    <ChatComposer
      pendingPermissionRequests={[]}
      handlePermissionDecision={noop}
      handleGrantToolPermission={() => ({ success: true })}
      activity={null}
      isLoading={false}
      onAbortSession={noop}
      permissionMode={permissionMode}
      onModeSwitch={noop}
      effort="default"
      availableEffortOptions={[]}
      onSelectEffort={noop}
      tokenBudget={null}
      onShowTokenUsage={noop}
      onToggleCommandMenu={noop}
      hasInput={false}
      onClearInput={noop}
      onSubmit={noop}
      isDragActive={false}
      queuedDrafts={[]}
      onEditQueuedDraft={noop}
      onDeleteQueuedDraft={noop}
      attachedImages={[]}
      onRemoveImage={noop}
      uploadingImages={new Map()}
      imageErrors={new Map()}
      showFileDropdown={false}
      filteredFiles={[]}
      selectedFileIndex={0}
      onSelectFile={noop}
      filteredCommands={[]}
      selectedCommandIndex={0}
      onCommandSelect={noop}
      onCloseCommandMenu={noop}
      isCommandMenuOpen={false}
      frequentCommands={[]}
      getRootProps={() => ({})}
      getInputProps={() => ({})}
      openImagePicker={noop}
      inputHighlightRef={{ current: null }}
      renderInputWithMentions={(text: string) => text}
      textareaRef={{ current: null }}
      input=""
      onInputChange={noop}
      onTextareaClick={noop}
      onTextareaKeyDown={noop}
      onTextareaPaste={noop}
      onTextareaScrollSync={noop}
      onTextareaInput={noop}
      placeholder="Type a message"
      isTextareaExpanded={false}
    />,
  );
}

/**
 * jsdom applies no CSS, so responsive spans all mount. A span carrying `hidden`
 * in its base classes is the one a phone would *not* see.
 */
function visibleLabelOf(pill: HTMLElement): string | undefined {
  return Array.from(pill.querySelectorAll('span'))
    .find((span) => !/(^|\s)hidden(\s|$)/.test(span.className))
    ?.textContent?.trim();
}

function modePill(): HTMLElement {
  return screen.getByTitle(/change permission mode/i) as HTMLElement;
}

describe('ChatComposer — permission-mode pill on phones (#239)', () => {
  it.each<[PermissionMode, string]>([
    ['default', 'Default'],
    ['acceptEdits', 'Accept'],
    ['auto', 'Auto'],
    ['bypassPermissions', 'Bypass'],
    ['plan', 'Plan'],
  ])('keeps a readable label for %s at phone widths', (mode, short) => {
    renderComposer(mode);

    expect(visibleLabelOf(modePill())).toBe(short);
  });

  it('still shows the full label once there is room', () => {
    renderComposer('bypassPermissions');

    const full = Array.from(modePill().querySelectorAll('span')).find((span) =>
      span.className.includes('sm:inline'),
    );
    expect(full?.textContent?.trim()).toBe('Bypass Permissions');
  });

  it('names the current mode in an accessible label, not just a title', () => {
    renderComposer('bypassPermissions');

    // `title` does nothing on touch, and the visible text is CSS-truncated to an
    // abbreviation, so the pill needs an explicit accessible name that spells
    // the mode out. (Falling back to text content is not enough — real CSS
    // hides most of it.)
    expect(modePill().getAttribute('aria-label')).toMatch(/Bypass Permissions/i);
  });

  it('gives the icon-only neighbours accessible names too', () => {
    renderComposer('default');

    expect(screen.getByRole('button', { name: /attach images/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show all commands/i })).toBeInTheDocument();
  });
});
