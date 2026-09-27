import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PermissionContext, { usePermission } from './PermissionContext';

function Consumer() {
  const value = usePermission();
  return <div data-testid="value">{value ? value.pendingPermissionRequests.length : 'null'}</div>;
}

describe('PermissionContext', () => {
  it('returns null outside any provider', () => {
    render(<Consumer />);
    expect(screen.getByTestId('value').textContent).toBe('null');
  });

  it('exposes whatever value the raw context Provider supplies', () => {
    const handlePermissionDecision = vi.fn();
    render(
      <PermissionContext.Provider
        value={{ pendingPermissionRequests: [{ id: '1' } as never], handlePermissionDecision }}
      >
        <Consumer />
      </PermissionContext.Provider>,
    );
    expect(screen.getByTestId('value').textContent).toBe('1');
  });
});
