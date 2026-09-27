import { describe, expect, it } from 'vitest';

import { AuthProvider, ProtectedRoute } from './index';

describe('auth index barrel', () => {
  it('re-exports AuthProvider and ProtectedRoute', () => {
    expect(typeof AuthProvider).toBe('function');
    expect(typeof ProtectedRoute).toBe('function');
  });
});
