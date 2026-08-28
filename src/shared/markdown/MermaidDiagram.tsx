/**
 * A ```` ```mermaid ```` fence, drawn as a diagram — or left as the code block it
 * already was.
 *
 * THE FALLBACK IS THE FEATURE. Agents emit malformed mermaid constantly, and a
 * transcript is not a diagram editor: a diagram that will not parse must cost
 * nothing more than the diagram, and must never take the message down with it.
 * So there is exactly one failure behaviour here, used for every reason a render
 * can fail — no runtime yet, source does not parse, mermaid itself threw — and
 * it is "render the ordinary code block the caller passed in". No error banner,
 * no empty box, no thrown exception escaping into the message list. What the
 * reader sees is what they would have seen before this feature existed.
 *
 * The caller is responsible for not mounting this until the fence has closed
 * (see `createMermaidFenceGate`), which is what keeps a streaming diagram from
 * being parsed — and redrawn, differently — on every token.
 */
import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../contexts/ThemeContext';

import { mermaidDiagramId } from './mermaidConfig';
import { loadMermaidRuntime } from './mermaidRuntimeLoader';

export type MermaidDiagramProps = {
  /** Raw diagram source, exactly as it appeared between the fences. */
  code: string;
  /** The code block to show whenever a diagram cannot be produced. */
  fallback: React.ReactNode;
};

export default function MermaidDiagram({ code, fallback }: MermaidDiagramProps) {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme();
  const diagramId = mermaidDiagramId(useId());
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    const source = code.trim();
    if (!source) {
      setSvg(null);
      return undefined;
    }

    let cancelled = false;
    loadMermaidRuntime()
      .then((runtime) => runtime.renderMermaid({ code: source, id: diagramId, isDarkMode }))
      .then((rendered) => {
        if (!cancelled) {
          setSvg(rendered);
        }
      })
      .catch((error) => {
        // Reaching here means mermaid broke, not that the diagram was invalid —
        // invalid source resolves to `null` above. Either way the source is
        // shown, but this one is worth a console breadcrumb.
        if (!cancelled) {
          setSvg(null);
        }
        console.warn('Mermaid failed to render a diagram; showing its source instead:', error);
      });

    return () => {
      cancelled = true;
    };
    // `isDarkMode` is a real dependency: mermaid bakes its palette into the SVG
    // at render time, so a theme switch has to re-render every diagram on screen.
    // The previous SVG stays mounted until the new one lands, so the switch is a
    // recolour rather than a flash back to source.
  }, [code, diagramId, isDarkMode]);

  if (!svg) {
    return <>{fallback}</>;
  }

  return (
    <div
      data-testid="mermaid-diagram"
      role="img"
      aria-label={t('mermaid.diagramLabel')}
      // Contain, then scroll.
      //
      // `mermaidInitConfig` turns off mermaid's fit-to-container sizing, so the
      // emitted SVG carries the diagram's natural pixel width (a four-actor
      // sequence diagram is ~1300 px). `overflow-x-auto` is what keeps that
      // width inside this box instead of in the transcript.
      //
      // `[&>svg]:max-w-none` is load-bearing and not decoration: `index.css` has
      // a blanket `.chat-message * { max-width: 100% }`, which is exactly why a
      // chat message never widens the page — and which silently shrank that
      // 1300 px diagram to 303 px on a phone, unreadable, with nothing to
      // scroll. Overriding it HERE rather than weakening the global rule keeps
      // the containment guarantee for everything else in the message.
      className="group relative my-2 overflow-x-auto rounded-xl border border-border bg-card p-4 [&>svg]:max-w-none"
      // Safe: mermaid renders at `securityLevel: 'strict'`, which runs the
      // markup through DOMPurify and strips scripts and event handlers.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
