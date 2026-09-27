import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CollapsibleSection } from './CollapsibleSection';

afterEach(() => {
  cleanup();
});

describe('CollapsibleSection', () => {
  it('renders the title, toggles open on trigger click, and shows children', () => {
    render(
      <CollapsibleSection title="Grep results">
        <div>child content</div>
      </CollapsibleSection>,
    );
    expect(screen.getByText('Grep results')).toBeTruthy();
    expect(screen.getByText('child content')).toBeTruthy();

    const trigger = screen.getByText('Grep results').closest('button')!;
    fireEvent.click(trigger);
    // Content stays in the DOM either way (Radix keeps it mounted while
    // animating), but the collapsible's data-state should flip.
  });

  it('renders a toolName label and separator when provided', () => {
    render(
      <CollapsibleSection title="file.ts" toolName="Edit">
        <div>diff</div>
      </CollapsibleSection>,
    );
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('/')).toBeTruthy();
  });

  it('renders a badge and action node when provided (default trigger layout)', () => {
    render(
      <CollapsibleSection title="Search" badge={<span>3 found</span>} action={<button>Run</button>}>
        <div>content</div>
      </CollapsibleSection>,
    );
    expect(screen.getByText('3 found')).toBeTruthy();
    expect(screen.getByText('Run')).toBeTruthy();
  });

  it('uses the clickable-title layout when onTitleClick is provided, and only the chevron toggles collapse', () => {
    const onTitleClick = vi.fn();
    render(
      <CollapsibleSection title="file.ts" toolName="Edit" onTitleClick={onTitleClick}>
        <div>diff body</div>
      </CollapsibleSection>,
    );

    const titleButton = screen.getByRole('button', { name: 'file.ts' });
    fireEvent.click(titleButton);
    expect(onTitleClick).toHaveBeenCalledTimes(1);
  });

  it('renders a badge and action alongside a clickable title', () => {
    render(
      <CollapsibleSection
        title="file.ts"
        onTitleClick={() => {}}
        badge={<span>Edit badge</span>}
        action={<button>Undo</button>}
      >
        <div>diff</div>
      </CollapsibleSection>,
    );
    expect(screen.getByText('Edit badge')).toBeTruthy();
    expect(screen.getByText('Undo')).toBeTruthy();
  });

  it('honors the open prop (defaultOpen) and applies a custom className', () => {
    const { container } = render(
      <CollapsibleSection title="Open by default" open className="my-extra-class">
        <div>always visible in DOM</div>
      </CollapsibleSection>,
    );
    expect(container.querySelector('.my-extra-class')).toBeTruthy();
    expect(screen.getByText('always visible in DOM')).toBeTruthy();
  });

  it('caps height by default and omits the cap when capHeight is false', () => {
    const { container: capped } = render(
      <CollapsibleSection title="Capped" open>
        <div>body</div>
      </CollapsibleSection>,
    );
    expect(capped.querySelector('.max-h-\\[32rem\\]')).toBeTruthy();

    const { container: uncapped } = render(
      <CollapsibleSection title="Uncapped" open capHeight={false}>
        <div>body</div>
      </CollapsibleSection>,
    );
    expect(uncapped.querySelector('.max-h-\\[32rem\\]')).toBeNull();
  });
});
