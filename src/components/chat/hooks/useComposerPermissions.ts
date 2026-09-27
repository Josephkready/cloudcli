import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { grantClaudeToolPermission } from '../utils/chatPermissions';
import type { PendingPermissionRequest } from '../types/types';
import type { LLMProvider } from '../../../types/app';

interface UseComposerPermissionsArgs {
  provider: LLMProvider;
  sendMessage: (message: unknown) => boolean;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
}

/** Tool-permission grant shortcut + the accept/deny response to a pending request. */
export function useComposerPermissions({
  provider,
  sendMessage,
  setPendingPermissionRequests,
}: UseComposerPermissionsArgs) {
  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  return { handleGrantToolPermission, handlePermissionDecision };
}
