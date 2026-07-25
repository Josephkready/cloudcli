// Ambient types for the `react-syntax-highlighter` entry points this app uses.
//
// Only the deep paths are declared, deliberately. The bare package root
// (`react-syntax-highlighter`) and the theme barrel (`.../dist/esm/styles/prism`)
// used to be declared here too, but nothing imports them any more: the root
// `Prism` export is what dragged all ~290 grammars into the entry chunk and the
// barrel re-exports ~40 themes (issue #268). Leaving those declarations behind
// would keep an untyped escape hatch open through which either could silently
// come back — without them, an accidental import fails `npm run typecheck`, and
// `scripts/check-entry-chunk.mjs` catches it in the built output as well.

// Used by `src/shared/markdown/prismLanguages.ts`, the single module allowed to
// touch these paths.
declare module 'react-syntax-highlighter/dist/esm/prism-light' {
  import type { ComponentType, CSSProperties, ReactNode } from 'react';

  /** A refractor grammar: `(prism) => void`, carrying `displayName`/`aliases`. */
  type PrismGrammar = (prism: unknown) => void;

  /** A Prism theme: selector -> CSS declarations, as the ESM theme modules ship it. */
  type PrismStyle = Record<string, Record<string, string>>;

  export type PrismLightProps = {
    language?: string;
    style?: PrismStyle;
    customStyle?: CSSProperties;
    codeTagProps?: { style?: CSSProperties; className?: string };
    useInlineStyles?: boolean;
    showLineNumbers?: boolean;
    wrapLines?: boolean;
    wrapLongLines?: boolean;
    PreTag?: string | ComponentType<Record<string, unknown>>;
    CodeTag?: string | ComponentType<Record<string, unknown>>;
    children?: ReactNode;
  };

  const SyntaxHighlighter: ComponentType<PrismLightProps> & {
    registerLanguage: (name: string, grammar: PrismGrammar) => void;
    alias: (name: string | Record<string, string | string[]>, aliases?: string | string[]) => void;
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
