import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ScrollArea } from './ScrollArea';

describe('ScrollArea', () => {
  it('renders children inside a scrollable inner container and forwards the ref', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <ScrollArea ref={ref} className="my-area" data-testid="outer">
        <span>content</span>
      </ScrollArea>,
    );

    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.getByTestId('outer').className).toContain('my-area');
    expect(ref.current).not.toBeNull();
    expect(ref.current?.className).toContain('overflow-auto');
  });
});
