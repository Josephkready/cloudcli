import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

import { disabledBusyControlClasses, disabledControlClasses } from './disabledState';

/*
 * #276: "disabled" used to mean five different opacities across 21 files, and
 * several call sites overrode the shared primitives. These tests pin the
 * acceptance criteria of that issue:
 *
 *  1. the treatment is defined exactly once — no `disabled:opacity-*` may
 *     appear anywhere in src/ other than disabledState.ts;
 *  2. the treatment does not rely on dimming a saturated colour alone;
 *  3. no control re-introduces `disabled:pointer-events-none`, which is what
 *     stopped a blocked button from explaining itself on hover.
 */

const SRC_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const THIS_MODULE = path.join(SRC_ROOT, 'shared/view/ui/disabledState.ts');

/**
 * Every shipped `.ts`/`.tsx` under src/. Test files are skipped: they quote
 * these utility names to assert on them (this file included), and no test
 * renders production styling.
 */
function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(absolute));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      found.push(absolute);
    }
  }
  return found;
}

/**
 * Lines that mention a `disabled:` utility, ignoring comments — the module's
 * own doc block talks about `disabled:opacity-*` and must not self-trip.
 */
function utilityHits(file: string, pattern: RegExp): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        return false;
      }
      return pattern.test(line);
    })
    .map((line) => line.trim());
}

describe('the disabled treatment is defined once (#276)', () => {
  const sourceFiles = collectSourceFiles(SRC_ROOT);

  test('src/ has files to scan', () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    assert.ok(sourceFiles.length > 100, `expected to scan src/, found ${sourceFiles.length} files`);
    assert.ok(sourceFiles.includes(THIS_MODULE));
  });

  test('no file outside disabledState.ts hard-codes a disabled:opacity-* override', () => {
    const offenders = sourceFiles
      .filter((file) => file !== THIS_MODULE)
      .flatMap((file) =>
        utilityHits(file, /disabled:opacity-/).map(
          (line) => `${path.relative(SRC_ROOT, file)}: ${line}`,
        ),
      );

    assert.deepEqual(
      offenders,
      [],
      'Import disabledControlClasses / disabledBusyControlClasses from '
        + 'shared/view/ui/disabledState instead of writing disabled:opacity-* at a call site (#276).',
    );
  });

  test('nothing re-introduces disabled:pointer-events-none', () => {
    const offenders = sourceFiles.flatMap((file) =>
      utilityHits(file, /disabled:pointer-events-none/).map(
        (line) => `${path.relative(SRC_ROOT, file)}: ${line}`,
      ),
    );

    assert.deepEqual(
      offenders,
      [],
      'A disabled control must stay hit-testable so its cursor and title can '
        + 'explain the block — the `disabled` attribute is what blocks activation (#276).',
    );
  });
});

describe('disabledState class strings', () => {
  test('carry a non-colour cue, not just opacity', () => {
    for (const classes of [disabledControlClasses, disabledBusyControlClasses]) {
      assert.match(classes, /\bdisabled:grayscale\b/);
      assert.match(classes, /\bdisabled:shadow-none\b/);
    }
  });

  test('use exactly one opacity value', () => {
    const opacities = new Set(
      [disabledControlClasses, disabledBusyControlClasses].flatMap((classes) =>
        [...classes.matchAll(/disabled:opacity-(\d+)/g)].map((match) => match[1]),
      ),
    );
    assert.deepEqual([...opacities], ['60']);
  });

  test('differ only in the cursor: blocked vs busy', () => {
    assert.match(disabledControlClasses, /\bdisabled:cursor-not-allowed\b/);
    assert.match(disabledBusyControlClasses, /\bdisabled:cursor-wait\b/);

    const withoutCursor = (classes: string) =>
      classes
        .split(/\s+/)
        .filter((token) => !token.startsWith('disabled:cursor-'))
        .join(' ');
    assert.equal(withoutCursor(disabledControlClasses), withoutCursor(disabledBusyControlClasses));
  });

  test('never pair two cursors on the same element', () => {
    for (const classes of [disabledControlClasses, disabledBusyControlClasses]) {
      assert.equal([...classes.matchAll(/disabled:cursor-/g)].length, 1);
    }
  });
});
