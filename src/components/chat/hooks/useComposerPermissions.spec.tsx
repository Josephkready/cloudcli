import { act, renderHook } from '@testing-library/react';
import type { Dispatch, SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PendingPermissionRequest } from '../types/types';

import { useComposerPermissions } from './useComposerPermissions';

function setup(provider: 'claude' | 'codex' | 'antigravity' = 'claude') {
  const sendMessage = vi.fn(() => true);
  const requests: PendingPermissionRequest[] = [
    { requestId: 'req-1', toolName: 'Bash' },
    { requestId: 'req-2', toolName: 'Write' },
  ];
  const setPendingPermissionRequests = vi.fn((update: PendingPermissionRequest[] | ((prev: PendingPermissionRequest[]) => PendingPermissionRequest[])) => {
    const next = typeof update === 'function' ? update(requests) : update;
    requests.splice(0, requests.length, ...next);
  }) satisfies Dispatch<SetStateAction<PendingPermissionRequest[]>>;

  const { result } = renderHook(() => useComposerPermissions({
    provider,
    sendMessage,
    setPendingPermissionRequests,
  }));

  return { result, sendMessage, setPendingPermissionRequests, requests };
}

describe('useComposerPermissions — accept/deny', () => {
  it('sends the server-expected chat.permission-response payload on allow', () => {
    const { result, sendMessage } = setup();

    act(() => {
      result.current.handlePermissionDecision('req-1', {
        allow: true,
        updatedInput: { command: 'ls' },
        rememberEntry: 'Bash(ls:*)',
      });
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'chat.permission-response',
      requestId: 'req-1',
      allow: true,
      updatedInput: { command: 'ls' },
      message: undefined,
      rememberEntry: 'Bash(ls:*)',
    });
  });

  it('sends allow: false on deny, coercing a missing allow flag to false', () => {
    const { result, sendMessage } = setup();

    act(() => {
      result.current.handlePermissionDecision('req-1', { message: 'no thanks' });
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'chat.permission-response',
      requestId: 'req-1',
      allow: false,
      updatedInput: undefined,
      message: 'no thanks',
      rememberEntry: undefined,
    });
  });

  it('removes the decided request from pendingPermissionRequests, leaving the rest', () => {
    const { result, requests } = setup();

    act(() => {
      result.current.handlePermissionDecision('req-1', { allow: true });
    });

    expect(requests.map((r) => r.requestId)).toEqual(['req-2']);
  });

  it('handles a batch of request ids in one decision, sending one message per id', () => {
    const { result, sendMessage, requests } = setup();

    act(() => {
      result.current.handlePermissionDecision(['req-1', 'req-2'], { allow: true });
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([]);
  });

  it('is a no-op when given no valid request ids', () => {
    const { result, sendMessage, requests } = setup();

    act(() => {
      result.current.handlePermissionDecision([], { allow: true });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(requests.map((r) => r.requestId)).toEqual(['req-1', 'req-2']);
  });
});

describe('useComposerPermissions — grant-tool-permission shortcut', () => {
  it('grants the entry when the provider is claude', () => {
    const { result } = setup('claude');

    let grantResult: { success: boolean } | undefined;
    act(() => {
      grantResult = result.current.handleGrantToolPermission({ entry: 'Bash(ls:*)', toolName: 'Bash' });
    });

    expect(grantResult?.success).toBe(true);
  });

  it('refuses to grant for a non-claude provider', () => {
    const { result } = setup('codex');

    let grantResult: { success: boolean } | undefined;
    act(() => {
      grantResult = result.current.handleGrantToolPermission({ entry: 'Bash(ls:*)', toolName: 'Bash' });
    });

    expect(grantResult).toEqual({ success: false });
  });

  it('refuses to grant when there is no suggestion', () => {
    const { result } = setup('claude');

    let grantResult: { success: boolean } | undefined;
    act(() => {
      grantResult = result.current.handleGrantToolPermission(
        undefined as unknown as { entry: string; toolName: string },
      );
    });

    expect(grantResult).toEqual({ success: false });
  });
});
