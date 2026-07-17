import type { ChatMessage } from '../types/types';

/**
 * Builds the label shown in a slash-command chip for a local-command user turn
 * (e.g. `/usage`). Prefers the parsed `commandName`, falls back to
 * `commandMessage`, and finally to the pre-built display `content`. The command
 * name is always normalized to exactly one leading slash so the chip reads
 * consistently regardless of how the producer formatted the field.
 *
 * `commandArgs` is appended only when the label is built from the structured
 * command fields — the raw `content` already includes any args, so appending
 * there would duplicate them.
 */
export function formatLocalCommandLabel(
  message: Pick<ChatMessage, 'commandName' | 'commandMessage' | 'commandArgs' | 'content'>,
): string {
  const rawName = message.commandName?.trim() || message.commandMessage?.trim() || '';

  if (rawName) {
    const name = `/${rawName.replace(/^\/+/, '')}`;
    const args = message.commandArgs?.trim();
    return args ? `${name} ${args}` : name;
  }

  return message.content?.trim() ?? '';
}
