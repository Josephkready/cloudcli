import { Suspense, lazy } from 'react';
import type { ReactNode } from 'react';

type MarkdownProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Demand-loaded shell around the real renderer (perf-audit package WP7).
 *
 * react-markdown + remark-gfm + the micromark/mdast/unified stack is ~450 KB
 * pre-minify — by far the biggest single contributor to the entry chunk — and
 * `app_boot` (composer + conversation list usable) never needs it: nothing
 * renders a message body until a conversation is actually opened. So the real
 * work lives in `MarkdownRenderer.tsx`, loaded through `React.lazy` here, and
 * `surfaceLoaders.ts` idle-warms it right after boot so the chunk is usually
 * already resident by the time a user opens a conversation.
 *
 * `MarkdownFallback` below renders the raw text in the same `whitespace-pre-wrap`
 * box the real renderer's paragraphs use, so the swap from fallback to
 * rendered markdown is a content change, not a layout jump — and so a message
 * is never blank while the chunk is in flight. The virtualized transcript
 * (`ChatMessagesPane.tsx`) already re-measures every row via
 * `rowVirtualizer.measureElement`'s `ResizeObserver` whenever a row's real
 * height differs from its estimate (Prism/Mermaid/images already do this
 * today), so the height change when the real renderer mounts is handled by
 * the same mechanism, not a new one.
 */
const LazyMarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

function MarkdownFallback({ children, className }: MarkdownProps) {
  const text = typeof children === 'string' ? children : String(children ?? '');
  return (
    <div className={className}>
      <div className="mb-2 whitespace-pre-wrap break-words last:mb-0">{text}</div>
    </div>
  );
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <Suspense fallback={<MarkdownFallback className={className}>{children}</MarkdownFallback>}>
      <LazyMarkdownRenderer className={className}>{children}</LazyMarkdownRenderer>
    </Suspense>
  );
}
