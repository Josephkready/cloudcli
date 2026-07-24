import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * `touch:*` is not a Tailwind variant — it is hand-written CSS in index.css
 * under `@media (hover: none) and (pointer: coarse)`. A component that writes
 * `touch:foo` with no matching rule therefore compiles, ships, and silently
 * does nothing, which is precisely how #244 shipped: project rows got
 * `touch:opacity-100` and the session/conversation rows never did.
 *
 * These pin that every `touch:` class used anywhere in src has a backing rule,
 * and that the rules live behind the coarse-pointer query.
 */

const SRC = path.resolve(import.meta.dirname, '..');
const CSS = readFileSync(path.join(SRC, 'index.css'), 'utf8');

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function usedTouchClasses(): Set<string> {
  const used = new Set<string>();
  for (const file of collectSourceFiles(SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\btouch:([a-z0-9-]+(?:\/[0-9]+)?)/g)) {
      used.add(match[1]);
    }
  }
  return used;
}

/** The `@media (hover: none) and (pointer: coarse)` blocks, brace-matched. */
function coarsePointerBlocks(): string {
  const blocks: string[] = [];
  const marker = '@media (hover: none) and (pointer: coarse)';
  let from = 0;

  for (;;) {
    const start = CSS.indexOf(marker, from);
    if (start === -1) break;

    let depth = 0;
    let i = CSS.indexOf('{', start);
    const open = i;
    for (; i < CSS.length; i++) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(CSS.slice(open, i));
    from = i;
  }

  return blocks.join('\n');
}

test('every touch: class used in src has a backing rule in index.css', () => {
  const coarse = coarsePointerBlocks();
  assert.ok(coarse.length > 0, 'expected at least one coarse-pointer media block');

  const used = [...usedTouchClasses()].sort();
  assert.ok(used.length > 0, 'expected components to use touch: classes');

  for (const name of used) {
    const selector = `.touch\\:${name.replace('/', '\\/')}`;
    assert.ok(
      coarse.includes(selector),
      `"touch:${name}" is used in src but has no ${selector} rule under the coarse-pointer media query`,
    );
  }
});

test('the reveal and the spacing utilities the sidebar rows rely on both exist', () => {
  const coarse = coarsePointerBlocks();

  assert.ok(coarse.includes('.touch\\:opacity-100'), 'missing .touch\\:opacity-100');
  assert.ok(coarse.includes('.touch\\:pr-16'), 'missing .touch\\:pr-16');
});
