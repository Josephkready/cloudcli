import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every full-screen overlay that can hold a text field must account for the
 * keyboard.
 *
 * #357 was fixed in the shared `Dialog`, which covers the dialogs built on it —
 * and silently *not* the four hand-rolled `fixed inset-0` overlays that never
 * used it. Those carry ten text inputs between them and had exactly the same
 * bug, unreported only because they are reached less often on a phone.
 *
 * The e2e sweep proves the *mechanism* works, but it can only prove it for
 * surfaces someone remembered to add. This is the complementary half: a
 * structural invariant over the source, so a **new** modal with an input fails
 * here the day it is written rather than the day it is reported. That ordering
 * is the entire point — this bug has been reported three times, and each report
 * cost a release cycle.
 *
 * It is deliberately coarse. It asks whether a file reasons about the keyboard
 * at all, not whether it does so correctly; correctness is the e2e sweep's job.
 * A coarse check that cannot be forgotten beats a precise one that can.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

/** Marks a full-screen overlay: it covers the viewport, so it owns its own bottom edge. */
const OVERLAY = /fixed inset-0/;

/** Marks something the soft keyboard would open for. */
const TEXT_ENTRY = /<input|<textarea|contentEditable|<Input\b|cmdk-input/;

/** Either the shared helper, the raw variable, or delegation to the shared Dialog. */
const KEYBOARD_AWARE = /keyboardAwareBottomStyle|--keyboard-height|DialogContent/;

/**
 * Overlays exempted by inspection, each with the reason.
 *
 * An allowlist rather than a loosened rule: adding a line here is a visible
 * decision in review, whereas widening the pattern silently drops whole
 * categories.
 */
const EXEMPT = new Map<string, string>([
  [
    'components/onboarding/view/Onboarding.tsx',
    'the fixed inset-0 element is a pointer-events-none decorative backdrop; the ' +
      'onboarding fields are laid out in normal flow beneath it',
  ],
  [
    'components/file-tree/view/FileTree.tsx',
    'the two are unrelated in this file: the fixed inset-0 overlay is a delete ' +
      'confirmation with no field, and the Input is the inline new-item row inside ' +
      'the ScrollArea, in normal flow. Revisit if that overlay ever gains a field',
  ],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('every full-screen overlay holding a text field accounts for the keyboard', () => {
  const offenders: string[] = [];

  for (const file of walk(SRC)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!OVERLAY.test(source) || !TEXT_ENTRY.test(source)) continue;

    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (EXEMPT.has(relative)) continue;
    if (KEYBOARD_AWARE.test(source)) continue;

    offenders.push(relative);
  }

  assert.deepEqual(
    offenders,
    [],
    'these overlays contain a text field but never reference the keyboard offset, so ' +
      'the field sits behind the keyboard on iOS (#357). Give the full-screen element ' +
      "`style={keyboardAwareBottomStyle()}` — or add it to EXEMPT with a reason:\n  " +
      offenders.join('\n  '),
  );
});

test('the exemption list does not outlive the files it exempts', () => {
  // A stale exemption is worse than none: it reads as "considered and excused"
  // while silently covering whatever later takes that path.
  for (const [relative, reason] of EXEMPT) {
    assert.ok(
      fs.existsSync(path.join(SRC, relative)),
      `EXEMPT names ${relative}, which no longer exists (reason given: ${reason})`,
    );
  }
});
