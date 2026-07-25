import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

/**
 * A tiny static-import walker, used to gate what may end up in the entry chunk.
 *
 * Issue #267 was not "the bundle is big" so much as "the bundle is big *for
 * reasons nothing enforces*": xterm and CodeMirror were split into their own
 * files by `manualChunks` while still sitting in the entry's static import
 * graph, so they were fetched and parsed on every cold load anyway. A single
 * `import Shell from …` added back in some future PR would silently undo the
 * fix, and nothing in the test suite would notice.
 *
 * Checking the built `dist/` would be the most direct guard, but `npm test`
 * does not build. Walking the source graph gets the same signal in
 * milliseconds, with no build step, and points at the offending *file* rather
 * than a hashed chunk name.
 *
 * The parser is deliberately syntactic rather than a real ES module parse: it
 * only needs to answer "which specifiers does this file pull in at load time",
 * and the two things that would make that wrong — dynamic `import()` and
 * type-only imports — are both cheap to recognise.
 */

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const NON_CODE_EXTENSIONS = ['.css', '.scss', '.svg', '.png', '.jpg', '.json'];

/** Strip comments that could otherwise be mistaken for import statements. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * True when an import clause is erased by the TypeScript compiler and therefore
 * cannot pull anything into the bundle: `import type { A } from 'x'` and
 * `import { type A, type B } from 'x'` are both type-only; `import { A, type B }`
 * is not.
 */
export function isTypeOnlyClause(clause: string | undefined): boolean {
  if (!clause) return false;

  const trimmed = clause.trim();
  if (/^type\b/.test(trimmed)) return true;

  const braces = trimmed.match(/^\{([\s\S]*)\}$/);
  if (!braces) return false;

  const bindings = braces[1]
    .split(',')
    .map((binding) => binding.trim())
    .filter(Boolean);

  return bindings.length > 0 && bindings.every((binding) => /^type\b/.test(binding));
}

/**
 * Every specifier this source pulls in *statically and for its value*.
 *
 * Dynamic `import(...)` is intentionally excluded — that is the whole point of
 * the split — as are type-only imports, which never reach the bundler.
 */
export function parseStaticImports(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];

  // `import … from 'x'` and the side-effect form `import 'x'`.
  // `[^;]` cannot cross a statement boundary, which keeps the lazy `+?` from
  // swallowing everything up to some later quote.
  const importPattern = /(?:^|[\n;])\s*import\s+(?:([^;]*?)\s+from\s*)?["']([^"']+)["']/g;
  for (const match of code.matchAll(importPattern)) {
    if (isTypeOnlyClause(match[1])) continue;
    specifiers.push(match[2]);
  }

  // Re-exports (`export { x } from 'y'`, `export * from 'y'`) load the module
  // just as an import does.
  const reExportPattern = /(?:^|[\n;])\s*export\s+([^;]*?)\s+from\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(reExportPattern)) {
    if (isTypeOnlyClause(match[1])) continue;
    specifiers.push(match[2]);
  }

  return specifiers;
}

function resolveFile(candidate: string): string | null {
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const withExtension = `${candidate}${extension}`;
    if (existsSync(withExtension)) return withExtension;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const asIndex = join(candidate, `index${extension}`);
    if (existsSync(asIndex)) return asIndex;
  }

  return null;
}

/**
 * Resolve a specifier to an absolute file path, or `null` when it is a bare
 * package specifier (or an asset the graph does not care about).
 */
export function resolveImport(specifier: string, fromFile: string, root: string): string | null {
  if (NON_CODE_EXTENSIONS.some((extension) => specifier.endsWith(extension))) {
    return null;
  }

  if (specifier.startsWith('.')) {
    return resolveFile(resolvePath(dirname(fromFile), specifier));
  }

  if (specifier.startsWith('@/')) {
    return resolveFile(join(root, 'src', specifier.slice(2)));
  }

  return null;
}

export type StaticGraph = {
  /** Every first-party file reachable from the entry without a dynamic import. */
  files: string[];
  /** Bare package specifier -> the first-party files that import it eagerly. */
  packages: Map<string, string[]>;
};

/**
 * Walk the first-party static import graph starting at `entry`.
 *
 * Anything only reachable through a dynamic `import()` is, by construction, not
 * in the entry chunk — so it never appears in the result.
 */
export function walkStaticGraph(entry: string, root: string): StaticGraph {
  const visited = new Set<string>();
  const packages = new Map<string, string[]>();
  const queue = [resolvePath(entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    for (const specifier of parseStaticImports(source)) {
      const resolved = resolveImport(specifier, file, root);
      if (resolved) {
        if (!visited.has(resolved)) queue.push(resolved);
        continue;
      }

      if (specifier.startsWith('.') || specifier.startsWith('@/')) continue;
      if (NON_CODE_EXTENSIONS.some((extension) => specifier.endsWith(extension))) continue;

      const importers = packages.get(specifier) ?? [];
      importers.push(file);
      packages.set(specifier, importers);
    }
  }

  return { files: [...visited], packages };
}
