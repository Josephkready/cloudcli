export type CopyFormat = 'text' | 'markdown';

export type CopyMessageType = 'user' | 'assistant' | 'error';

// Converts markdown into readable plain text for "Copy as text".
export function convertMarkdownToPlainText(markdown: string): string {
  let plainText = markdown.replace(/\r\n/g, '\n');
  const codeBlocks: string[] = [];
  plainText = plainText.replace(/```[\w-]*\n([\s\S]*?)```/g, (_match, code: string) => {
    const placeholder = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push(code.replace(/\n$/, ''));
    return placeholder;
  });
  plainText = plainText.replace(/`([^`]+)`/g, '$1');
  plainText = plainText.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1');
  plainText = plainText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  plainText = plainText.replace(/^>\s?/gm, '');
  plainText = plainText.replace(/^#{1,6}\s+/gm, '');
  plainText = plainText.replace(/^[-*+]\s+/gm, '');
  plainText = plainText.replace(/^\d+\.\s+/gm, '');
  plainText = plainText.replace(/(\*\*|__)(.*?)\1/g, '$2');
  plainText = plainText.replace(/(\*|_)(.*?)\1/g, '$2');
  plainText = plainText.replace(/~~(.*?)~~/g, '$1');
  plainText = plainText.replace(/<\/?[^>]+(>|$)/g, '');
  plainText = plainText.replace(/\n{3,}/g, '\n\n');
  plainText = plainText.replace(/@@CODEBLOCK(\d+)@@/g, (_match, index: string) => codeBlocks[Number(index)] ?? '');
  return plainText.trim();
}

// Resolves the exact text placed on the clipboard for a given copy control.
// Error/stderr output is verbatim diagnostic text (#145/#151), NOT markdown:
// running it through the markdown→plain-text stripper would delete
// `<anonymous>` / `Map<K,V>` tokens, unwrap backtick-wrapped paths, drop
// leading `#`/`-`/`*`/`>` markers, and collapse stack-trace blank lines — the
// exact corruption those issues exist to prevent. Copy it raw.
export function resolveCopyPayload(
  content: string,
  format: CopyFormat,
  messageType: CopyMessageType,
): string {
  if (messageType === 'error') return content;
  if (format === 'markdown') return content;
  return convertMarkdownToPlainText(content);
}
