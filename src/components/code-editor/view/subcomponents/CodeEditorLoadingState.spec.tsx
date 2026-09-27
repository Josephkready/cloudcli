import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import CodeEditorLoadingState from './CodeEditorLoadingState';

describe('CodeEditorLoadingState', () => {
  it('renders the compact sidebar layout', () => {
    render(<CodeEditorLoadingState isDarkMode={false} isSidebar loadingText="Loading a.ts..." />);
    expect(screen.getByText('Loading a.ts...')).toBeInTheDocument();
  });

  it('renders the modal layout with dark-mode styles injected', () => {
    const { container } = render(
      <CodeEditorLoadingState isDarkMode isSidebar={false} loadingText="Loading b.ts..." />,
    );
    expect(screen.getByText('Loading b.ts...')).toBeInTheDocument();
    expect(container.querySelector('style')?.textContent).toContain('#111827');
  });
});
