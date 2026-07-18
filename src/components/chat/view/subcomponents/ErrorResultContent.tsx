import React from 'react';

interface ErrorResultContentProps {
  content: string;
}

/**
 * Renders tool error/stderr output as preformatted monospace text (#145).
 *
 * Diagnostic output — stack traces, CLI stderr, compiler diagnostics — is almost
 * never Markdown. Running it through the prose Markdown renderer collapses
 * significant whitespace/indentation (stack-trace alignment, `^^^` column
 * pointers), misinterprets leading `#`/`-`/`*`/`>`/numbered lines as
 * headers/lists/block-quotes, and swallows `<...>` / backtick-wrapped tokens
 * (e.g. `<anonymous>`, `Map<K,V>`). We preserve the raw text verbatim, wrapping
 * long lines and breaking unbreakable tokens (paths, URLs) so the box can't
 * overflow horizontally. Color is inherited from the surrounding error box.
 */
export const ErrorResultContent: React.FC<ErrorResultContentProps> = ({ content }) => (
  <pre className="whitespace-pre-wrap break-words font-mono text-sm">{content}</pre>
);
