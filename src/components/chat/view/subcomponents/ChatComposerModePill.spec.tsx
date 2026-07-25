import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ComponentProps } from 'react';
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

type ComposerOverrides = Partial<ComponentProps<typeof ChatComposer>>;

function renderComposer(permissionMode: PermissionMode, overrides: ComposerOverrides = {}) {
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
      {...overrides}
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

/*
 * Touch targets in the composer's control row (#275).
 *
 * jsdom does no layout — every `getBoundingClientRect()` here is zeros — so the
 * 44px itself is not measurable in this suite and is verified in a browser
 * instead. What jsdom *can* hold is the wiring: each control in the row claims
 * a hit-area utility, and that utility is one the stylesheet actually backs.
 * `touch:` is hand-written CSS rather than a Tailwind variant, so a control
 * carrying a class with no rule looks fixed in the markup and ships a 32px tap
 * target (#244). Reading the rule names out of index.css instead of hardcoding
 * them means a renamed utility fails here rather than silently doing nothing.
 */

// jsdom rewrites `import.meta.url` to an http: URL, so resolve from the vitest
// root instead.
const CSS = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');

/** Utilities that index.css backs with a 44px-tall `::after` overlay. */
const hitAreaUtilities = new Set(
  Array.from(CSS.matchAll(/\.touch\\:([a-z0-9-]+)::after/g), (match) => match[1]),
);

function hitAreaClassOf(element: Element): string | undefined {
  return element.className
    .split(/\s+/)
    .find((token) => token.startsWith('touch:') && hitAreaUtilities.has(token.slice('touch:'.length)));
}

describe('ChatComposer — control-row touch targets (#275)', () => {
  it('backs every control in the row with a hit-area rule that exists', () => {
    const { container } = renderComposer('default', {
      availableEffortOptions: [{ value: 'high' }],
      tokenBudget: { used: 1234 },
      hasInput: true,
    });

    const footer = container.querySelector('[data-slot="prompt-input-footer"]');
    const controls = Array.from(footer?.querySelectorAll('button') ?? []);

    // The row is the attach button, the pill, effort, token usage, the command
    // menu, clear, and submit — if a control is ever added without a hit area,
    // this is the test that notices.
    expect(controls.length).toBeGreaterThanOrEqual(6);
    expect(hitAreaUtilities.size).toBeGreaterThan(0);

    for (const control of controls) {
      expect(
        hitAreaClassOf(control),
        `"${control.getAttribute('aria-label') ?? control.textContent}" has no hit-area utility backed by index.css`,
      ).toBeDefined();
    }
  });

  /*
   * The axis choice per control is the load-bearing decision, not the presence
   * of some hit-area class: `hit-44` floors both axes and `hit-h-44` floors
   * height only. Widening a 32px icon button in the `gap-1` row would push its
   * overlay 2px over the neighbour's visible edge and steal that neighbour's
   * taps, so getting the axis wrong reintroduces the bug #275 fixed.
   *
   * Asserting a few named controls left most of the row unpinned — flipping the
   * token chip to `hit-h-44` (or a spacious control to the narrow token) passed.
   * This compares the whole row as a set, so a wrong token *and* a new control
   * added without a deliberate choice both fail.
   */
  const EXPECTED_HIT_AREAS: Record<string, string> = {
    'attach images': 'touch:hit-h-44',
    'show all commands': 'touch:hit-h-44',
  };

  const labelOf = (control: Element) =>
    (control.getAttribute('aria-label') ?? control.textContent ?? '').trim().toLowerCase();

  it('assigns every control in the row an axis, and only widens ones with room', () => {
    const { container } = renderComposer('default', {
      availableEffortOptions: [{ value: 'high' }],
      tokenBudget: { used: 1234 },
      hasInput: true,
    });

    const footer = container.querySelector('[data-slot="prompt-input-footer"]');
    const controls = Array.from(footer?.querySelectorAll('button') ?? []);
    expect(controls.length).toBeGreaterThanOrEqual(6);

    const actual = Object.fromEntries(
      controls.map((control) => [labelOf(control), hitAreaClassOf(control)]),
    );

    // Every control resolves to one of the two utilities — no control silently
    // opts out, and no third token appears without this test being updated.
    for (const [label, utility] of Object.entries(actual)) {
      expect(['touch:hit-44', 'touch:hit-h-44'], `"${label}" has an unexpected hit-area utility`)
        .toContain(utility);
    }

    // The icon-only 32px buttons must floor height ONLY. This is the direction
    // that causes tap-stealing, so it is pinned by name.
    for (const [label, expected] of Object.entries(EXPECTED_HIT_AREAS)) {
      expect(actual[label], `"${label}" is a 32px icon button in a gap-1 row`).toBe(expected);
    }

    // The permission pill has room after #239, so it floors both axes.
    expect(hitAreaClassOf(modePill())).toBe('touch:hit-44');

    // Both utilities are genuinely in use, so neither branch of the rule is
    // dead and this test cannot pass by everything collapsing to one token.
    const used = new Set(Object.values(actual));
    expect(used.has('touch:hit-44')).toBe(true);
    expect(used.has('touch:hit-h-44')).toBe(true);
  });

  /*
   * The overlay is positioned against the control, so the control must
   * establish a containing block. Without the `position: relative` anchor the
   * `::after` resolves against the nearest positioned ancestor and the hit area
   * lands somewhere else entirely — silently, since the class is still present.
   */
  it('anchors the hit-area overlay on the control itself', () => {
    const anchorRule = /\.touch\\:hit-44,\s*\.touch\\:hit-h-44\s*\{[^}]*position:\s*relative/;
    expect(CSS).toMatch(anchorRule);
  });

  it('leaves the painted height alone so the row keeps its alignment', () => {
    renderComposer('default');

    // The fix is the overlay, not the box: an `h-11` here would be option 1 from
    // #275 (raise the row) and would break the row's shared 32px rhythm.
    const pill = modePill();
    expect(pill.className).toMatch(/(^|\s)h-8(\s|$)/);
    expect(pill.className).not.toMatch(/(^|\s)h-(9|10|11|12)(\s|$)/);
  });
});
