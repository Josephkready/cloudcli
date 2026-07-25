declare module 'react-syntax-highlighter';
declare module 'react-syntax-highlighter/dist/esm/styles/prism';

// Deep entry points used by `src/shared/markdown/prismLanguages.ts`. The package
// ships no types for these paths, and importing the typed package root is what
// dragged all ~290 grammars into the entry chunk (issue #268).
declare module 'react-syntax-highlighter/dist/esm/prism-light' {
  import type { ComponentType } from 'react';

  type PrismGrammar = (prism: unknown) => void;

  const SyntaxHighlighter: ComponentType<Record<string, unknown>> & {
    registerLanguage: (name: string, grammar: PrismGrammar) => void;
    alias: (name: string | Record<string, string | string[]>, aliases?: string | string[]) => void;
    supportedLanguages?: string[];
  };

  export default SyntaxHighlighter;
}

declare module 'react-syntax-highlighter/dist/esm/languages/prism/*' {
  const grammar: (prism: unknown) => void;
  export default grammar;
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/*' {
  const style: Record<string, Record<string, string>>;
  export default style;
}
