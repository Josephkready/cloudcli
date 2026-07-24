import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionsSource } from './useSessionsSource';

/*
 * Untitled sessions in the palette (#234). A session has no summary until the
 * provider writes one, so every freshly created chat showed up in Ctrl+K as a
 * 36-character UUID — several of them indistinguishable from each other, which
 * defeats the point of a picker. The sidebar rendered the very same session as
 * "New Session" at that moment.
 */

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

const UNTITLED_ID = '9087a325-bc69-49dd-bf3a-2a6ee529f4d2';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mockSessions(sessions: Record<string, unknown>[]) {
  authenticatedFetch.mockResolvedValue({ json: async () => ({ sessions }) } as unknown as Response);
}

async function labels(sessions: Record<string, unknown>[]) {
  mockSessions(sessions);
  const { result } = renderHook(() => useSessionsSource('project-1', true));
  await waitFor(() => expect(result.current.length).toBe(sessions.length));
  return result.current.map((s) => s.label);
}

describe('useSessionsSource — untitled session labels (#234)', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
  });

  it('never falls back to the raw session id', async () => {
    const [label] = await labels([{ id: UNTITLED_ID }]);

    expect(label).not.toMatch(UUID_PATTERN);
    expect(label).not.toBe(UNTITLED_ID);
  });

  it('uses the same "New Session" placeholder the sidebar shows', async () => {
    const [label] = await labels([{ id: UNTITLED_ID }]);

    expect(label).toBe('New Session');
  });

  it('still prefers title, then summary, then name', async () => {
    const result = await labels([
      { id: 'a', title: 'Titled', summary: 'Summ', name: 'Nm' },
      { id: 'b', summary: 'Summ', name: 'Nm' },
      { id: 'c', name: 'Nm' },
    ]);

    expect(result).toEqual(['Titled', 'Summ', 'Nm']);
  });

  it('keeps the id on the result so search-by-id keeps working', async () => {
    mockSessions([{ id: UNTITLED_ID }]);
    const { result } = renderHook(() => useSessionsSource('project-1', true));
    await waitFor(() => expect(result.current.length).toBe(1));

    expect(result.current[0].id).toBe(UNTITLED_ID);
  });
});
