import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { walkStaticGraph } from './staticImportGraph';

/*
 * Entry-chunk guard for issue #267.
 *
 * The bug was not the *size* of any one library, it was that xterm and
 * CodeMirror were reachable from `main.jsx` without a single dynamic import —
 * `manualChunks` had split them into separate files, so the build output looked
 * healthy, while the browser still fetched and parsed ~1 MB of editor and
 * terminal code before it could paint a chat message. A 2.3 s main-thread
 * freeze at 4x CPU throttle.
 *
 * One ordinary-looking `import Shell from '…'` puts all of it back. These
 * assertions name the file that did it.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY = join(ROOT, 'src/main.jsx');

/** Libraries that must only ever be reachable through a dynamic import. */
const DEMAND_LOADED_PACKAGES = [
  { prefix: '@xterm/', reason: 'the terminal (~400 KB) belongs to the shell tab' },
  { prefix: '@codemirror/', reason: 'the editor (~690 KB) belongs to the code editor' },
  { prefix: '@uiw/react-codemirror', reason: 'the editor (~690 KB) belongs to the code editor' },
  { prefix: '@replit/codemirror-minimap', reason: 'the editor minimap belongs to the code editor' },
  { prefix: 'jszip', reason: 'zip export belongs to the files tab' },
  { prefix: 'dompurify', reason: 'SVG sanitising belongs to the plugin icon fetch path' },
  // #287. Both were reachable from the chat composer, so they loaded on boot
  // for every session — including ones with no code block and no attachment.
  {
    prefix: 'react-syntax-highlighter',
    reason: 'the highlighter + grammars (~100 KB) belong to rendered code blocks',
  },
  {
    prefix: 'react-dropzone',
    reason: 'still used by the skills upload surface, which is behind a lazy boundary',
  },
  // The largest dependency in the app — mermaid drags d3, dagre, cytoscape,
  // langium and its own KaTeX along with it. Only `src/shared/markdown/
  // mermaidRuntime.ts` may import it, and only a dynamic `import()` may reach
  // that module. `import type { MermaidConfig } from 'mermaid'` in
  // `mermaidConfig.ts` is fine and deliberately not an exception here: the
  // walker erases type-only imports, exactly as the bundler does.
  {
    prefix: 'mermaid',
    reason: 'the diagram engine (~1 MB) belongs to rendered ```mermaid fences',
  },
];

const graph = walkStaticGraph(ENTRY, ROOT);

describe('entry chunk static import graph (#267)', () => {
  it('walks a graph that is actually the app', () => {
    // Without this, a walker that silently resolved nothing would make every
    // other assertion in this file vacuously true.
    assert.ok(graph.files.length > 100, `expected a real graph, walked ${graph.files.length} files`);
    assert.ok(graph.packages.has('react'), 'expected React to be an eager dependency');

    const chat = join(ROOT, 'src/components/chat/view/ChatInterface.tsx');
    assert.ok(graph.files.includes(chat), 'chat is on the critical path and should stay eager');
  });

  for (const { prefix, reason } of DEMAND_LOADED_PACKAGES) {
    it(`does not load ${prefix} on boot — ${reason}`, () => {
      const offenders = [...graph.packages.entries()]
        .filter(([specifier]) => specifier === prefix || specifier.startsWith(prefix))
        .flatMap(([specifier, importers]) =>
          importers.map((importer) => `${relative(ROOT, importer)} -> ${specifier}`),
        );

      assert.deepEqual(
        offenders,
        [],
        `${prefix} is back in the entry chunk via a static import:\n  ${offenders.join('\n  ')}`,
      );
    });
  }

  it('keeps the heavy surfaces out of the eager file set', () => {
    const mustBeLazy = [
      'src/components/shell/view/Shell.tsx',
      'src/components/standalone-shell/view/StandaloneShell.tsx',
      'src/components/code-editor/view/CodeEditor.tsx',
      'src/components/code-editor/view/EditorSidebar.tsx',
      'src/components/git-panel/view/GitPanel.tsx',
      'src/components/settings/view/Settings.tsx',
      'src/components/file-tree/view/FileTree.tsx',
      'src/components/command-palette/CommandPalette.tsx',
      'src/components/project-creation-wizard/ProjectCreationWizard.tsx',
      'src/components/onboarding/view/Onboarding.tsx',
      // #287: the highlighted code block. Its unhighlighted stand-in
      // (`PlainCodeBlock`) IS eager by design — that is the point of the split,
      // and it must never import from this module or Prism comes back with it.
      'src/shared/markdown/PrismCodeBlock.tsx',
      'src/shared/markdown/prismLanguages.ts',
      // The mermaid engine. Its detection (`mermaidFences.ts`), its config
      // (`mermaidConfig.ts`) and the component that draws the result
      // (`MermaidDiagram.tsx`) ARE eager by design — none of them imports
      // mermaid, and the component needs to be on hand to render the code-block
      // fallback while the chunk is still in flight.
      'src/shared/markdown/mermaidRuntime.ts',
    ];

    const eager = mustBeLazy.filter((path) => graph.files.includes(join(ROOT, path)));

    assert.deepEqual(eager, [], `these surfaces must stay behind React.lazy:\n  ${eager.join('\n  ')}`);
  });
});

/*
 * The source-graph assertions above are the enforceable ones; this checks the
 * artefact the browser actually receives — the acceptance criterion from the
 * issue, verbatim. It needs `npm run build:client`, which `npm test`
 * deliberately does not run, so it reports rather than fails when there is no
 * build to look at.
 */
describe('built index.html (#267)', () => {
  const indexHtmlPath = join(ROOT, 'dist/index.html');
  const built = existsSync(indexHtmlPath);
  const skip = built ? false : 'no dist/ — run `npm run build:client` to check the built output';

  it('does not modulepreload the editor or terminal bundles', { skip }, () => {
    const html = readFileSync(indexHtmlPath, 'utf8');
    const preloaded = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map(
      (match) => match[1],
    );

    assert.ok(preloaded.length > 0, 'expected at least the React vendor chunk to be preloaded');
    assert.deepEqual(
      preloaded.filter((href) => /vendor-(codemirror|xterm)/.test(href)),
      [],
      'the editor / terminal bundles are being fetched on every cold load again',
    );
  });
});
