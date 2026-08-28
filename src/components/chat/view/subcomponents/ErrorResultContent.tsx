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
 * (e.g. `<anonymous>`, `Map<K,V>`). We preserve the raw text verbatim.
 *
 * That verbatim intent is why this scrolls sideways rather than wrapping: the
 * alignment #145 exists to protect — stack-trace indentation, `^^^` column
 * pointers — only survives if a long line stays one line. Wrapping moved the
 * pointer off its column, which is the whole thing the caret is for.
 * Color is inherited from the surrounding error box.
 */
export const ErrorResultContent: React.FC<ErrorResultContentProps> = ({ content }) => (
  <pre className="overflow-x-auto whitespace-pre font-mono">{content}</pre>
);
