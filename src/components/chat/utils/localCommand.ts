import type { ChatMessage } from '../types/types';

/**
 * Builds the label shown in a slash-command chip for a local-command user turn
 * (e.g. `/usage`). Prefers the parsed `commandName` (already slash-prefixed),
 * falls back to `commandMessage` (adding the leading slash), and finally to the
 * pre-built display `content`.
 *
 * `commandArgs` is appended only when the label is built from the structured
 * command fields — the raw `content` already includes any args, so appending
 * there would duplicate them.
 */
export function formatLocalCommandLabel(
  message: Pick<ChatMessage, 'commandName' | 'commandMessage' | 'commandArgs' | 'content'>,
): string {
  const name = message.commandName?.trim()
    || (message.commandMessage?.trim()
      ? `/${message.commandMessage.trim().replace(/^\/+/, '')}`
      : '');

  if (name) {
    const args = message.commandArgs?.trim();
    return args ? `${name} ${args}` : name;
  }

  return message.content?.trim() ?? '';
}
