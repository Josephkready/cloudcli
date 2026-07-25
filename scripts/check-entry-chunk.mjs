#!/usr/bin/env node
// scripts/check-entry-chunk.mjs
//
// Entry-chunk regression gate for issues #268 and #269.
//
// WHY THIS EXISTS
//   Both issues were caused by a single import line, and both are trivially
//   reintroduced by one:
//     - `import { Prism } from 'react-syntax-highlighter'` pulls refractor with
//       all ~290 language grammars into the entry chunk (#268).
//     - `import 'katex/dist/katex.min.css'` (or a static `rehype-katex` import
//       from anything the entry reaches) puts ~18.6 KB of `.katex` rules back
//       into the render-blocking stylesheet (#269).
//   The unit and component suites cannot see either regression: they exercise
//   runtime behaviour, which stays perfectly correct while the bundle silently
//   doubles. Only the built output shows it, so this reads the built output.
//
// WHAT IT CHECKS (against `dist/assets/`)
//   1. No grammar this app never registers appears in the entry JS chunk.
//   2. No `.katex` rule appears in the entry (render-blocking) CSS.
//   3. No KaTeX code appears in the entry JS chunk.
//   4. Positive controls, so the gate cannot pass vacuously if the marker
//      format or the file layout changes: a registered grammar IS present in
//      the entry chunk, and KaTeX IS still shipped in an on-demand chunk.
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
  const { js: entryJsName, css: entryCssName } = parseEntryRefs(readFileSync(indexHtmlPath, 'utf8'));
  const entryJs = readFileSync(join(assetsDir, entryJsName), 'utf8');
  const entryCss = readFileSync(join(assetsDir, entryCssName), 'utf8');

  const failures = [];
  const notes = [];

  // 1. Unused grammars must not be in the entry chunk (#268).
  const leakedGrammars = FORBIDDEN_GRAMMARS.filter((name) => containsGrammar(entryJs, name));
  if (leakedGrammars.length > 0) {
    failures.push(
      `${entryJsName} contains unregistered Prism grammars: ${leakedGrammars.join(', ')}. ` +
        'Something is importing `react-syntax-highlighter` (the package root) again instead of ' +
        'src/shared/markdown/prismLanguages.ts (issue #268).',
    );
  } else {
    notes.push(`no unregistered grammars in ${entryJsName} (checked ${FORBIDDEN_GRAMMARS.length})`);
  }

  // 2. Positive control: the grammars we DO register must be there, otherwise
  //    check 1 is passing for the wrong reason.
  const presentGrammars = EXPECTED_GRAMMARS.filter((name) => containsGrammar(entryJs, name));
  if (presentGrammars.length === 0) {
    failures.push(
      `${entryJsName} contains none of the registered grammars (${EXPECTED_GRAMMARS.join(', ')}). ` +
        'The `displayName` marker this gate matches on has probably changed — fix the gate ' +
        'rather than assuming the bundle is clean.',
    );
  } else {
    notes.push(`registered grammars still present: ${presentGrammars.join(', ')}`);
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

  if (entryJs.includes('katex')) {
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
