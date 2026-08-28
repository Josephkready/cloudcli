#!/usr/bin/env node
// scripts/check-entry-chunk.mjs
//
// Entry-chunk regression gate for issues #268, #269 and mermaid diagrams.
//
// WHY THIS EXISTS
//   Each of these was caused by a single import line, and each is trivially
//   reintroduced by one:
//     - `import { Prism } from 'react-syntax-highlighter'` pulls refractor with
//       all ~290 language grammars into the entry chunk (#268).
//     - `import 'katex/dist/katex.min.css'` (or a static `rehype-katex` import
//       from anything the entry reaches) puts ~18.6 KB of `.katex` rules back
//       into the render-blocking stylesheet (#269).
//     - `import mermaid from 'mermaid'` is the biggest of the three by some way:
//       the diagram engine and its transitive d3 / dagre / cytoscape / langium /
//       KaTeX tree is ~650 KB minified, for a feature the overwhelming majority
//       of chat messages never use.
//   The unit and component suites cannot see any of these regressions: they
//   exercise runtime behaviour, which stays perfectly correct while the bundle
//   silently doubles. Only the built output shows it, so this reads the built
//   output.
//
// WHAT IT CHECKS (against `dist/assets/`)
//   1. No grammar this app never registers appears in the entry JS chunk.
//   2. No `.katex` rule appears in the entry (render-blocking) CSS.
//   3. No KaTeX code appears in the entry JS chunk.
//   4. No mermaid code appears in the entry JS chunk, and nothing the entry
//      `modulepreload`s carries it either — a chunk that is fetched on every
//      cold load is on the boot path whether or not it is the entry file.
//   5. Positive controls, so the gate cannot pass vacuously if the marker
//      format or the file layout changes: a registered grammar IS present in
//      the entry chunk, and KaTeX and mermaid ARE still shipped on demand.
//
// USAGE
//   npm run build:client && npm run check:bundle
//   node scripts/check-entry-chunk.mjs [distDir]     # default: dist
//   node scripts/check-entry-chunk.mjs --self-test   # marker-matching self-tests

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Grammars nobody could plausibly need in a coding-assistant UI. Their presence
 * means the full refractor grammar set is back in the entry chunk.
 *
 * Matched as `displayName="<name>"` rather than as a bare word on purpose: the
 * bundle also contains an unrelated MIME-type table where "cobol", "wolfram"
 * and "fortran" legitimately appear (`vnd.acucobol`, `vnd.wolfram.player`,
 * `text/x-fortran`), and a bare-substring check would fail on those forever.
 */
const FORBIDDEN_GRAMMARS = [
  'abap',
  'brainfuck',
  'cobol',
  'erlang',
  'fortran',
  'haskell',
  'nasm',
  'verilog',
  'wolfram',
];

/** At least one of these must be present, or the marker format has drifted. */
const EXPECTED_GRAMMARS = ['typescript', 'python', 'rust'];

/** Minified refractor grammars register themselves via `displayName`. */
export function grammarMarkers(name) {
  return [`displayName="${name}"`, `displayName:"${name}"`, `displayName='${name}'`];
}

export function containsGrammar(source, name) {
  return grammarMarkers(name).some((marker) => source.includes(marker));
}

/**
 * Diagram-type ids that only mermaid's runtime ships.
 *
 * The library name itself is useless as a marker: this repo's own eager code
 * legitimately contains the word "mermaid" (the `language-mermaid` class it
 * matches on, the `mermaid-…` render ids it mints, the name of the on-demand
 * chunk), so a bare `includes('mermaid')` would fail forever with the split
 * working perfectly. These strings come from mermaid's diagram registry and
 * appear nowhere in application code.
 */
const MERMAID_MARKERS = ['stateDiagram-v2', 'flowchart-v2', 'erDiagram', 'quadrantChart', 'sequenceDiagram'];

/**
 * Blank out emitted asset filenames before searching a chunk for library code.
 *
 * Vite writes a preload table into every chunk that dynamically imports another
 * (`__vite__mapDeps(["assets/katex-HP8lGamR.js", …])`), so the entry chunk
 * contains the NAME of each chunk it can reach. Adding mermaid was enough to
 * make Rollup split KaTeX into a chunk of its own — at which point the string
 * `katex` appeared in the entry chunk and check 3 failed, despite the entry
 * containing not one line of KaTeX. Filenames are references, not code; only
 * what is left after they are removed says anything about what actually shipped.
 */
export function stripAssetFilenames(source) {
  return source.replace(/assets\/[A-Za-z0-9_.-]+\.(?:js|mjs|css)/g, 'assets/<chunk>');
}

/** Which of `markers` appear in `source`, ignoring emitted asset filenames. */
export function findMarkers(source, markers) {
  const code = stripAssetFilenames(source);
  return markers.filter((marker) => code.includes(marker));
}

/**
 * Resolve the real entry files from `index.html` rather than globbing
 * `assets/index-*`.
 *
 * Code splitting (#267) means several emitted chunks can match that glob — a
 * lazily-imported module whose source file is also called `index` gets the same
 * prefix. Globbing found 2 and the gate refused to run. More importantly, only
 * the files `index.html` actually references are render-blocking, and those are
 * exactly what these checks are about, so reading the HTML is both more robust
 * and more correct than pattern-matching filenames.
 */
export function parseEntryRefs(html) {
  const js = html.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
  const css = html.match(/<link[^>]+rel="stylesheet"[^>]+href="\/assets\/([^"]+\.css)"/);
  if (!js) {
    throw new Error('index.html has no module script referencing /assets/*.js');
  }
  if (!css) {
    throw new Error('index.html has no stylesheet referencing /assets/*.css');
  }
  return { js: js[1], css: css[1] };
}

/**
 * The chunks `index.html` asks the browser to `modulepreload`.
 *
 * Being outside the entry FILE is not the same as being off the boot path: a
 * preloaded chunk is fetched and parsed on every cold load too, which is exactly
 * what made #267 invisible for so long (`manualChunks` had split the editor and
 * terminal into their own files while the entry still preloaded them). So the
 * mermaid check reads this as well as the entry chunk.
 */
export function parsePreloadRefs(html) {
  return [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/assets\/([^"]+\.js)"/g)].map(
    (match) => match[1],
  );
}

function checkBundle(distDir) {
  const assetsDir = join(distDir, 'assets');
  if (!existsSync(assetsDir)) {
    throw new Error(`no built assets at ${assetsDir} — run \`npm run build:client\` first`);
  }
  const files = readdirSync(assetsDir);

  const indexHtmlPath = join(distDir, 'index.html');
  if (!existsSync(indexHtmlPath)) {
    throw new Error(`no ${indexHtmlPath} — run \`npm run build:client\` first`);
  }
  const indexHtml = readFileSync(indexHtmlPath, 'utf8');
  const { js: entryJsName, css: entryCssName } = parseEntryRefs(indexHtml);
  const preloadedNames = parsePreloadRefs(indexHtml);
  const entryJs = readFileSync(join(assetsDir, entryJsName), 'utf8');
  const entryCss = readFileSync(join(assetsDir, entryCssName), 'utf8');

  const failures = [];
  const notes = [];

  // Since #287 the highlighter is demand-loaded, so the grammars legitimately
  // live in a chunk of their own rather than in the entry chunk. Checks 1 and 2
  // therefore read every emitted chunk: shipping all ~290 grammars is just as
  // wasteful behind a lazy boundary as it was in front of one, and the positive
  // control has to look where the grammars actually are or it goes vacuous the
  // moment they move.
  const chunkNames = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
  const chunks = chunkNames.map((name) => ({
    name,
    source: readFileSync(join(assetsDir, name), 'utf8'),
  }));
  const someChunkHas = (grammar) => chunks.filter((chunk) => containsGrammar(chunk.source, grammar));

  // 1. Unused grammars must not ship at all (#268).
  const leaked = FORBIDDEN_GRAMMARS.flatMap((name) =>
    someChunkHas(name).map((chunk) => `${name} in ${chunk.name}`),
  );
  if (leaked.length > 0) {
    failures.push(
      `unregistered Prism grammars are being shipped: ${leaked.join(', ')}. ` +
        'Something is importing `react-syntax-highlighter` (the package root) again instead of ' +
        'src/shared/markdown/prismLanguages.ts (issue #268).',
    );
  } else {
    notes.push(`no unregistered grammars in any chunk (checked ${FORBIDDEN_GRAMMARS.length})`);
  }

  // 2. Positive control: the grammars we DO register must be somewhere, or
  //    check 1 is passing for the wrong reason.
  const presentGrammars = EXPECTED_GRAMMARS.filter((name) => someChunkHas(name).length > 0);
  if (presentGrammars.length === 0) {
    failures.push(
      `no chunk contains any registered grammar (${EXPECTED_GRAMMARS.join(', ')}). ` +
        'The `displayName` marker this gate matches on has probably changed — fix the gate ' +
        'rather than assuming the bundle is clean.',
    );
  } else {
    notes.push(`registered grammars still shipped: ${presentGrammars.join(', ')}`);
  }

  // 2b. …but NOT in the entry chunk (#287). This is the saving itself: the
  //     highlighter used to load on boot for every session, code or not.
  const eagerGrammars = EXPECTED_GRAMMARS.filter((name) => containsGrammar(entryJs, name));
  if (eagerGrammars.length > 0) {
    failures.push(
      `${entryJsName} contains Prism grammars (${eagerGrammars.join(', ')}). ` +
        'The highlighter must stay behind the lazy boundary in Markdown.tsx — check that ' +
        'nothing eager imports PrismCodeBlock or prismLanguages, including the loading ' +
        'fallback (issue #287).',
    );
  } else {
    notes.push(`no Prism grammars in ${entryJsName} — highlighter is demand-loaded`);
  }

  // 3. KaTeX must not be on the render-blocking path (#269).
  const katexCssRules = (entryCss.match(/\.katex/g) || []).length;
  if (katexCssRules > 0) {
    failures.push(
      `${entryCssName} contains ${katexCssRules} \`.katex\` rules. KaTeX's stylesheet belongs in the ` +
        'lazily-imported src/shared/markdown/mathRuntime.ts chunk, not the render-blocking bundle (issue #269).',
    );
  } else {
    notes.push(`no \`.katex\` rules in ${entryCssName}`);
  }

  // The filename strip matters here: since mermaid arrived, Rollup emits a
  // `katex-<hash>.js` chunk (KaTeX is shared between the math and mermaid
  // runtimes) and its NAME is listed in the entry's preload table.
  if (stripAssetFilenames(entryJs).includes('katex')) {
    failures.push(
      `${entryJsName} references KaTeX. Only src/shared/markdown/mathRuntime.ts may import it, and only ` +
        'that module may be reached through a dynamic `import()` (issue #269).',
    );
  } else {
    notes.push(`no KaTeX code in ${entryJsName}`);
  }

  // 4. Positive control: KaTeX must still ship somewhere on demand, so this
  //    gate fails loudly if the feature is deleted rather than deferred.
  const mathChunkCss = files.filter((file) => /^mathRuntime-[^.]+\.css$/.test(file));
  const mathChunkJs = files.filter((file) => /^mathRuntime-[^.]+\.js$/.test(file));
  if (mathChunkCss.length === 0 || mathChunkJs.length === 0) {
    failures.push(
      'no on-demand `mathRuntime-*.{js,css}` chunk was emitted. Math rendering should be lazy, not absent — ' +
        'if it was intentionally removed, update this gate too.',
    );
  } else {
    notes.push(`on-demand math chunk present: ${mathChunkJs[0]} + ${mathChunkCss[0]}`);
  }

  // 5. Mermaid must not be on the boot path. It is the largest dependency in
  //    the app, and only `src/shared/markdown/mermaidRuntime.ts` may import it —
  //    reachable solely through the `import()` in mermaidRuntimeLoader.ts.
  const eagerMermaid = findMarkers(entryJs, MERMAID_MARKERS);
  if (eagerMermaid.length > 0) {
    failures.push(
      `${entryJsName} contains mermaid (${eagerMermaid.join(', ')}). Only ` +
        'src/shared/markdown/mermaidRuntime.ts may import `mermaid`, and only mermaidRuntimeLoader.ts may ' +
        'reach it, through a dynamic `import()`. A static import from anything the entry touches — including ' +
        'MermaidDiagram.tsx or mermaidConfig.ts, which hold no runtime mermaid on purpose — puts ~650 KB of ' +
        'diagram engine on every cold load.',
    );
  } else {
    notes.push(`no mermaid code in ${entryJsName}`);
  }

  // 5b. …and neither may anything index.html preloads: a preloaded chunk is
  //     fetched on boot too, so being outside the entry file is not enough.
  const preloadedMermaid = preloadedNames.filter((name) => {
    const path = join(assetsDir, name);
    return existsSync(path) && findMarkers(readFileSync(path, 'utf8'), MERMAID_MARKERS).length > 0;
  });
  if (preloadedMermaid.length > 0) {
    failures.push(
      `index.html modulepreloads mermaid via ${preloadedMermaid.join(', ')}. Splitting the engine into its ` +
        'own chunk is not enough if that chunk is still fetched on every cold load.',
    );
  } else {
    notes.push(`no mermaid in any modulepreloaded chunk (checked ${preloadedNames.length})`);
  }

  // 6. Positive controls for mermaid, mirroring the KaTeX pair above: the
  //    engine must still ship SOMEWHERE (or check 5 passes because the feature
  //    was deleted, or because the markers drifted), and it must be behind the
  //    boundary this repo actually built.
  const mermaidChunks = chunks.filter((chunk) => findMarkers(chunk.source, MERMAID_MARKERS).length > 0);
  if (mermaidChunks.length === 0) {
    failures.push(
      `no chunk contains any mermaid marker (${MERMAID_MARKERS.join(', ')}). Either diagram rendering was ` +
        'removed — in which case update this gate too — or mermaid renamed its diagram types and the markers ' +
        'need refreshing. Do not assume the bundle is clean.',
    );
  } else {
    notes.push(`mermaid still shipped on demand in ${mermaidChunks.length} chunk(s)`);
  }

  const mermaidRuntimeChunk = files.filter((file) => /^mermaidRuntime-[^.]+\.js$/.test(file));
  if (mermaidRuntimeChunk.length === 0) {
    failures.push(
      'no on-demand `mermaidRuntime-*.js` chunk was emitted. The dynamic `import()` in ' +
        'src/shared/markdown/mermaidRuntimeLoader.ts is what creates it — if it is gone, mermaid is either ' +
        'absent or folded into something eager.',
    );
  } else {
    notes.push(`on-demand mermaid chunk present: ${mermaidRuntimeChunk[0]}`);
  }

  return { failures, notes, entryJsName, entryCssName, entryJsBytes: entryJs.length, entryCssBytes: entryCss.length };
}

function selfTest() {
  const cases = [
    ['matches a minified double-quoted displayName', 'x.displayName="brainfuck"', 'brainfuck', true],
    ['matches an object-literal displayName', '{displayName:"abap"}', 'abap', true],
    ['ignores a bare word in unrelated data', '["acu","application/vnd.acucobol"]', 'cobol', false],
    ['ignores a MIME type', '["f90","text/x-fortran"]', 'fortran', false],
    ['ignores a similar package name', 'vnd.wolfram.player', 'wolfram', false],
  ];

  let failed = 0;
  for (const [label, source, name, expected] of cases) {
    const actual = containsGrammar(source, name);
    if (actual !== expected) {
      console.error(`✗ ${label}: expected ${expected}, got ${actual}`);
      failed += 1;
    } else {
      console.log(`✓ ${label}`);
    }
  }

  // Entry resolution reads index.html rather than globbing assets/index-*,
  // because code splitting (#267) can emit more than one file matching that
  // glob. These pin the parsing, including that it picks the *referenced*
  // chunk and not merely the first index-like filename it sees.
  const htmlCases = [
    [
      'picks the entry chunk index.html actually references',
      '<script type="module" crossorigin src="/assets/index-ABC.js"></script>' +
        '<link rel="stylesheet" crossorigin href="/assets/index-XYZ.css">',
      { js: 'index-ABC.js', css: 'index-XYZ.css' },
    ],
    [
      'ignores modulepreloaded sibling chunks',
      '<link rel="modulepreload" href="/assets/index-OTHER.js">' +
        '<script type="module" crossorigin src="/assets/index-REAL.js"></script>' +
        '<link rel="stylesheet" href="/assets/index-REAL.css">',
      { js: 'index-REAL.js', css: 'index-REAL.css' },
    ],
  ];
  for (const [label, html, expected] of htmlCases) {
    try {
      const actual = parseEntryRefs(html);
      if (actual.js !== expected.js || actual.css !== expected.css) {
        console.error(`✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        failed += 1;
      } else {
        console.log(`✓ ${label}`);
      }
    } catch (error) {
      console.error(`✗ ${label}: threw ${error.message}`);
      failed += 1;
    }
  }

  // The filename strip is the difference between "the entry contains KaTeX" and
  // "the entry knows the name of the chunk that does". Getting it wrong in
  // either direction breaks the gate: too greedy and a real regression walks
  // through, too shy and the gate fails on a perfectly split bundle (which is
  // exactly what happened the day mermaid gave KaTeX a chunk of its own).
  const stripCases = [
    ['drops a chunk filename from the preload table', '__vite__mapDeps(["assets/katex-HP8lGamR.js"])', 'katex', false],
    [
      'drops a mermaid diagram chunk filename',
      '["assets/stateDiagram-v2-MP3YSRHH-DXCCLIUi.js","assets/x.css"]',
      'stateDiagram-v2',
      false,
    ],
    ['drops the mermaid runtime chunk filename', '"assets/mermaidRuntime-Cux2shEV.js"', 'mermaidRuntime', false],
    ['keeps real library code', 'const t={erDiagram:1,flowchart:2}', 'erDiagram', true],
    ['keeps KaTeX code that is not a filename', 'function katexRender(e){}', 'katex', true],
    [
      'keeps a marker that merely sits next to a filename',
      '["assets/index-A.js"];var q="quadrantChart"',
      'quadrantChart',
      true,
    ],
  ];
  for (const [label, source, marker, expected] of stripCases) {
    const actual = stripAssetFilenames(source).includes(marker);
    if (actual !== expected) {
      console.error(`✗ ${label}: expected ${expected}, got ${actual}`);
      failed += 1;
    } else {
      console.log(`✓ ${label}`);
    }
  }

  // `findMarkers` is what the mermaid checks are built on, so pin that it reads
  // through the strip rather than around it.
  const markerCases = [
    ['findMarkers reports a real mermaid marker', 'x="erDiagram"', ['erDiagram', 'flowchart-v2'], ['erDiagram']],
    ['findMarkers ignores chunk filenames', '"assets/erDiagram-ABC123.js"', ['erDiagram'], []],
    ['findMarkers returns nothing for unrelated code', 'const a=1', ['erDiagram'], []],
  ];
  for (const [label, source, markers, expected] of markerCases) {
    const actual = findMarkers(source, markers);
    if (actual.join(',') !== expected.join(',')) {
      console.error(`✗ ${label}: expected [${expected}], got [${actual}]`);
      failed += 1;
    } else {
      console.log(`✓ ${label}`);
    }
  }

  // Preload parsing feeds check 5b; an empty result would make it vacuous.
  const preloadCases = [
    [
      'collects modulepreloaded chunks and ignores the entry script',
      '<link rel="modulepreload" href="/assets/vendor-react-A.js">' +
        '<script type="module" src="/assets/index-B.js"></script>' +
        '<link rel="modulepreload" href="/assets/vendor-x-C.js">',
      ['vendor-react-A.js', 'vendor-x-C.js'],
    ],
    ['returns nothing when nothing is preloaded', '<script type="module" src="/assets/index-B.js"></script>', []],
  ];
  for (const [label, html, expected] of preloadCases) {
    const actual = parsePreloadRefs(html);
    if (actual.join(',') !== expected.join(',')) {
      console.error(`✗ ${label}: expected [${expected}], got [${actual}]`);
      failed += 1;
    } else {
      console.log(`✓ ${label}`);
    }
  }

  // A build that emits no entry script must fail loudly, not silently pass.
  for (const [label, html] of [
    ['throws when no entry script is referenced', '<link rel="stylesheet" href="/assets/index-A.css">'],
    ['throws when no stylesheet is referenced', '<script type="module" src="/assets/index-A.js"></script>'],
  ]) {
    try {
      parseEntryRefs(html);
      console.error(`✗ ${label}: expected a throw, got none`);
      failed += 1;
    } catch {
      console.log(`✓ ${label}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} self-test(s) failed.`);
    process.exit(1);
  }
  console.log('\nEntry-chunk gate self-tests passed.');
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  const distDir = args.find((arg) => !arg.startsWith('--')) || 'dist';
  let result;
  try {
    result = checkBundle(distDir);
  } catch (error) {
    console.error(`Entry-chunk check could not run: ${error.message}`);
    process.exit(1);
  }

  console.log(`Entry chunk: ${result.entryJsName} (${result.entryJsBytes} B)`);
  console.log(`Entry CSS:   ${result.entryCssName} (${result.entryCssBytes} B)`);
  for (const note of result.notes) {
    console.log(`✓ ${note}`);
  }
  if (result.failures.length > 0) {
    console.error('');
    for (const failure of result.failures) {
      console.error(`✗ ${failure}`);
    }
    console.error('\nEntry-chunk check failed.');
    process.exit(1);
  }
  console.log('\nEntry-chunk check passed.');
}
