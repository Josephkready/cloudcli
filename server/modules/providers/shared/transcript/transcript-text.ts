/**
 * Text helpers shared by every code path that reads a provider transcript.
 *
 * The session providers and the conversation-search service both parse the
 * *same* on-disk JSONL, so they need the same primitives: the tag surface
 * Claude wraps local slash commands in, the ANSI codes captured stdout carries,
 * and the visibility rule for Codex `user_message` events. Those primitives
 * used to be copied into each consumer, which let them drift apart silently —
 * a transcript row could render one way in chat and match differently in
 * search. They live here so there is exactly one definition of each.
 */

import type { AnyRecord } from '@/shared/types.js';

/** Escapes a value for literal use inside a `RegExp` source string. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
export function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = escapeRegex(tagName);
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
export function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
export function parseClaudeLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
export function buildClaudeLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * True for the Codex `user_message` events a person actually typed.
 *
 * Codex reuses `user_message` for harness-injected turns and tags them with a
 * non-`plain` `kind`; those must stay out of both chat history and search.
 */
export function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}
