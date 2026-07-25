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

/*
 * Dropping `disabled:pointer-events-none` (#276) made disabled buttons
 * hit-testable so their cursor and title could explain the block. It also made
 * `:hover` and `:active` match them — so any unscoped hover/active utility on a
 * control carrying the disabled treatment now fires *while disabled*. The
 * shared treatment overrides opacity, filter, box-shadow and cursor; it does
 * not override background-color or text-decoration, so those leak through: a
 * disabled `ghost`/`outline` button grows a background wash on hover, and a
 * disabled `link` button underlines.
 *
 * The rule is enforced here rather than asserted in a review, because the
 * failure is invisible to every runtime test — the button correctly refuses to
 * activate, it just lies about being interactive.
 */
describe('Button variants must not react to hover while disabled', () => {
  const buttonSource = readFileSync(fileURLToPath(new URL('./Button.tsx', import.meta.url)), 'utf8');

  const variantBlock = () => {
    const start = buttonSource.indexOf('variants: {');
    const end = buttonSource.indexOf('defaultVariants:');
    assert.ok(start !== -1 && end > start, 'could not locate the cva variants block in Button.tsx');
    return buttonSource.slice(start, end);
  };

  test('every hover: and active: utility in the variants is enabled:-scoped', () => {
    const unscoped = [...variantBlock().matchAll(/(?<![\w:-])(hover|active):[\w[\]/.-]+/g)].map(
      (match) => match[0],
    );

    assert.deepEqual(
      unscoped,
      [],
      'Button variants carry unscoped hover/active utilities: ' +
        `${unscoped.join(', ')}. Since #276 removed disabled:pointer-events-none, these fire on ` +
        'disabled buttons. Prefix them with `enabled:`.',
    );
  });

  test('the scoped utilities are still present, so the check is not vacuous', () => {
    const scoped = [...variantBlock().matchAll(/enabled:(hover|active):/g)];
    assert.ok(
      scoped.length >= 8,
      `expected the variants to still define enabled:hover/active utilities, found ${scoped.length}`,
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
