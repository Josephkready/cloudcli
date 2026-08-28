/**
 * Literal fixtures for the mock agent provider's code-surface reply.
 *
 * Deliberately a module of its own, with NO imports: the Playwright specs read
 * these constants, and importing them from `mock-agent-provider.js` would pull
 * in `server/shared/utils.js` — and through it the `@/*` path alias, which the
 * e2e tsconfig does not map. Keeping the literals dependency-free lets the spec
 * and the provider share one source of truth without widening that config.
 *
 * Single source of truth matters here specifically: a spec that hard-coded its
 * own copy of the sentinel would silently stop selecting the code-surface reply
 * if the provider's value ever changed, and would then assert against the
 * ordinary prose reply — passing while testing nothing.
 */

/**
 * Ask the mock for a reply built out of code surfaces instead of prose.
 *
 * Opt-in by sentinel so the default reply — which several suites assert
 * verbatim via `MOCK_ASSISTANT_TEXT` — is completely unchanged.
 */
export const MOCK_CODE_BLOCK_SENTINEL = '__CODE_SURFACES__';

/** A line far wider than any test viewport, with no space to wrap at. */
export const MOCK_LONG_CODE_LINE =
  'const resultOfAVeryDeliberatelyLongExpression = computeSomething(alphaArgument, betaArgument, gammaArgument, deltaArgument, epsilonArgument);';

/** A single unbroken token, the shape `word-break: break-all` used to chop. */
export const MOCK_LONG_INLINE_TOKEN =
  'src/components/chat/tools/components/ContentRenderers/TextContent.tsx';

/** A Bash invocation whose command and output are both wider than a phone. */
export const MOCK_WIDE_BASH_COMMAND =
  'rg --no-heading --line-number "whitespace-pre-wrap" src/components/chat/tools/components/';

export const MOCK_WIDE_BASH_OUTPUT = [
  'src/components/chat/tools/components/ContentRenderers/TextContent.tsx:37:      <pre className="mt-1 max-h-80 overflow-auto whitespace-pre rounded border">',
  'src/components/chat/tools/components/CollapsibleDisplay.tsx:76:      <pre className="mt-1 max-h-80 overflow-auto whitespace-pre rounded border">',
  'ok',
].join('\n');

/** An Edit whose before/after lines both overflow the column. */
export const MOCK_DIFF_FILE = 'src/components/chat/tools/components/ToolDiffViewer.tsx';
export const MOCK_DIFF_OLD =
  '  <div className="font-mono text-[11px] leading-[18px]"> {/* the wide original line that used to wrap */}';
export const MOCK_DIFF_NEW =
  '  <div data-scrolls-x className="overflow-x-auto font-mono text-[11px] leading-[18px]"> {/* now scrolls */}';
