import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

/*
 * #271: the app shipped 64 `transition-all` and six ad-hoc durations
 * (100/150/200/300/400/500ms). Both are the kind of thing that creeps back one
 * component at a time — a copy-pasted row, a new modal — and neither is
 * observable to a runtime test, because the classes only matter once Tailwind
 * has compiled them and a browser has painted.
 *
 * So this is a source guard, in the style of touchVariants.test.ts and
 * disabledState.test.ts. It pins the acceptance criteria of #271:
 *
 *  1. no `transition-all` anywhere — it makes the browser watch every
 *     animatable property, including layout ones, on elements that repeat once
 *     per list row;
 *  2. every duration comes from the semantic scale, so timing is tuned in
 *     tailwind.config.js and not at ~90 call sites;
 *  3. the scale keeps feedback at or under 120ms and overlays at or under
 *     220ms;
 *  4. the list rows the issue names never animate a layout property, and any
 *     other file that does is on an explicit, justified allowlist;
 *  5. `prefers-reduced-motion` still suppresses all of it.
 */

const SRC = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(SRC, '..');
const CSS_PATH = path.join(SRC, 'index.css');
const CSS = readFileSync(CSS_PATH, 'utf8');
const TAILWIND_CONFIG = readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf8');

/** The semantic scale. `DEFAULT` is what a bare `transition-*` bakes in. */
const SCALE = ['instant', 'fast', 'base', 'slow'] as const;

/**
 * CSS properties whose animation forces layout. Transitioning one of these
 * makes the browser re-layout on every frame instead of compositing, which is
 * the specific cost `transition-all` was hiding.
 */
const LAYOUT_PROPERTIES = [
  'width',
  'height',
  'max-height',
  'min-height',
  'max-width',
  'min-width',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'margin',
  'padding',
  'grid-template-rows',
  'grid-template-columns',
  'flex-basis',
  'font-size',
];

/**
 * Files allowed to transition a layout property, and why. Everything here
 * animates a *size the user asked to change* — a progress bar filling, a panel
 * disclosing — where there is no transform that expresses the same thing.
 * Nothing here is a list row.
 */
const LAYOUT_TRANSITION_ALLOWLIST: Record<string, string> = {
  'shared/view/ui/Collapsible.tsx': 'grid-template-rows is the height-agnostic disclosure trick',
  'components/chat/tools/components/ContentRenderers/TaskListContent.tsx': 'todo progress bar fill',
  'components/chat/tools/components/InteractiveRenderers/AskUserQuestionPanel.tsx': 'step dot widens to mark the current question',
  'components/file-tree/view/FileTreeHeader.tsx': 'upload progress bar fill',
  'components/file-tree/view/FileTreeUploadProgress.tsx': 'upload progress bar fill',
  'components/git-panel/view/GitViewTabs.tsx': 'max-height collapse of the tab strip',
  'components/git-panel/view/changes/CommitComposer.tsx': 'max-height collapse of the composer',
  'components/git-panel/view/changes/FileChangeItem.tsx': 'max-height reveal of the inline diff',
  'components/git-panel/view/changes/FileSelectionControls.tsx': 'max-height collapse of the controls row',
  'components/quick-settings-panel/view/QuickSettingsHandle.tsx': 'the drag handle is positioned by `right`',
  'components/sidebar/view/subcomponents/SidebarContent.tsx': 'search progress bar fill',
  'components/sidebar/view/subcomponents/SidebarProjectsState.tsx': 'project-load progress bar fill',
};

/** The repeating rows #271 calls out: their per-element cost multiplies. */
const LIST_ROWS = [
  'components/sidebar/view/subcomponents/SidebarProjectItem.tsx',
  'components/sidebar/view/subcomponents/SidebarSessionItem.tsx',
  'components/sidebar/view/subcomponents/SidebarConversationsList.tsx',
  'components/file-tree/view/FileTreeNode.tsx',
];

function collectSourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(absolute, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(absolute);
    }
  }
  return out;
}

const SOURCE_FILES = collectSourceFiles(SRC);

/**
 * Lines of a file with comment-only lines dropped. Prose is allowed to name
 * `transition-all` — this very repo explains in comments why it is gone — but
 * a class string is not.
 */
function codeLines(file: string): { line: string; number: number }[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
}

function relative(file: string): string {
  return path.relative(SRC, file);
}

function bracedBlock(source: string, marker: RegExp): string {
  const match = marker.exec(source);
  assert.ok(match, `could not find ${marker} block`);
  const open = source.indexOf('{', match.index);
  assert.notEqual(open, -1, `could not find opening brace for ${marker}`);

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }

  assert.fail(`could not find closing brace for ${marker}`);
}

function transitionDurationTokens(): Map<string, number> {
  const block = bracedBlock(TAILWIND_CONFIG, /transitionDuration\s*:/);
  const tokens = new Map<string, number>();
  for (const [, name, value] of block.matchAll(/(\w+):\s*'(\d+)ms'/g)) {
    tokens.set(name, Number(value));
  }
  return tokens;
}

/** Every `transition-[a,b,c]` arbitrary property list in a file. */
function arbitraryTransitionLists(file: string): string[][] {
  const lists: string[][] = [];
  for (const { line } of codeLines(file)) {
    for (const match of line.matchAll(/transition-\[([a-z-,_]+)\]/g)) {
      lists.push(match[1].split(',').map((property) => property.trim()));
    }
  }
  return lists;
}

type InlineTransition = {
  line: number;
  declaration: 'transition' | 'transitionDuration' | 'transitionProperty';
  value: string;
};

/**
 * Transition declarations in TS/TSX style objects. Requiring a quoted value
 * intentionally excludes CSS text embedded in template literals while still
 * covering `style={{ transition: '…' }}` and reusable `CSSProperties` objects.
 */
function parseInlineTransitions(source: string): InlineTransition[] {
  const declarations: InlineTransition[] = [];
  const pattern = /\b(transition|transitionDuration|transitionProperty)\s*:\s*(['"`])([\s\S]*?)\2/g;
  for (const match of source.matchAll(pattern)) {
    declarations.push({
      line: source.slice(0, match.index).split('\n').length,
      declaration: match[1] as InlineTransition['declaration'],
      value: match[3],
    });
  }
  return declarations;
}

function inlineTransitions(file: string): InlineTransition[] {
  return parseInlineTransitions(
    codeLines(file).map(({ line }) => line).join('\n'),
  );
}

function transitionProperties(value: string): string[] {
  return value.split(',').flatMap((part) => {
    const property = part.trim().split(/\s+/)[0]?.toLowerCase();
    return property ? [property] : [];
  });
}

function durationsInMs(value: string): number[] {
  return [...value.matchAll(/\b(\d+(?:\.\d+)?)(ms|s)\b/g)]
    .map(([, amount, unit]) => Number(amount) * (unit === 's' ? 1_000 : 1));
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    if (value[index] === ')') depth = Math.max(0, depth - 1);
    if (value[index] === ',' && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
}

describe('the semantic motion scale (#271)', () => {
  test('src/ has files to scan', () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    assert.ok(SOURCE_FILES.length > 100, `expected to scan src/, found ${SOURCE_FILES.length} files`);
    assert.ok(CSS.length > 1000, 'expected to read index.css');
  });

  test('tailwind.config.js defines the scale, and only the scale', () => {
    const tokens = transitionDurationTokens();

    assert.deepEqual(
      [...tokens.keys()].sort(),
      ['DEFAULT', ...SCALE].sort(),
      'the scale must be exactly DEFAULT + instant/fast/base/slow',
    );

    // A bare `transition-colors` must land on the feedback step, not Tailwind's
    // 150ms default — that is what retimes the ~140 sites that name no duration.
    assert.equal(tokens.get('DEFAULT'), tokens.get('fast'), 'DEFAULT must equal fast');

    const [instant, fast, base, slow] = SCALE.map((name) => tokens.get(name)!);
    assert.ok(instant < fast && fast < base && base < slow, `scale is not ordered: ${[...tokens]}`);

    // #271's acceptance: feedback ≤120ms, overlays ≤220ms.
    assert.ok(fast <= 120, `hover/press feedback must be ≤120ms, got ${fast}ms`);
    assert.ok(slow <= 220, `the slowest step must be ≤220ms, got ${slow}ms`);
  });

  test('nothing uses transition-all', () => {
    const classOffenders = SOURCE_FILES.flatMap((file) =>
      codeLines(file)
        .filter(({ line }) => line.includes('transition-all'))
        .map(({ number }) => `${relative(file)}:${number}`),
    );
    const inlineOffenders = SOURCE_FILES.flatMap((file) =>
      inlineTransitions(file)
        .filter(({ declaration, value }) =>
          declaration !== 'transitionDuration' && transitionProperties(value).includes('all'))
        .map(({ line }) => `${relative(file)}:${line}`),
    );

    assert.deepEqual(
      [...classOffenders, ...inlineOffenders],
      [],
      'transition-all watches every animatable property, including layout ones. '
        + 'Name the properties: transition-colors, transition-transform, transition-opacity, '
        + 'or an explicit transition-[a,b] list.',
    );
  });

  test('index.css never falls back to transition: all either', () => {
    assert.doesNotMatch(CSS, /transition:\s*all\b/, 'index.css sets `transition: all`');
    assert.doesNotMatch(CSS, /transition-property:\s*all\b/, 'index.css sets `transition-property: all`');
  });

  test('inline transition parser covers multiline shorthand and longhands', () => {
    const parsed = parseInlineTransitions(`
      const style = {
        transition:
          'width 300ms ease',
        transitionProperty: "height",
        transitionDuration: \`0.4s\`,
      };
    `);

    assert.deepEqual(
      parsed.map(({ declaration, value }) => [declaration, value.trim()]),
      [
        ['transition', 'width 300ms ease'],
        ['transitionProperty', 'height'],
        ['transitionDuration', '0.4s'],
      ],
    );
  });

  test('animation lists split only at top-level commas', () => {
    assert.deepEqual(
      splitTopLevelCommas(
        'fade 160ms cubic-bezier(0.4, 0, 0.2, 1), slide 200ms ease',
      ).map((part) => part.trim()),
      [
        'fade 160ms cubic-bezier(0.4, 0, 0.2, 1)',
        'slide 200ms ease',
      ],
    );
  });

  test('every duration class comes from the scale', () => {
    const offenders = SOURCE_FILES.flatMap((file) =>
      codeLines(file).flatMap(({ line, number }) =>
        [...line.matchAll(/\bduration-(\[[^\]]*\]|[\w.]+)/g)]
          .filter(([, token]) => !(SCALE as readonly string[]).includes(token))
          .map(([match]) => `${relative(file)}:${number}: ${match}`),
      ),
    );

    assert.deepEqual(
      offenders,
      [],
      `use the semantic scale (${SCALE.map((name) => `duration-${name}`).join(', ')}) `
        + 'so timing stays tunable in tailwind.config.js. Tailwind scans raw text, so the '
        + 'class must be written out literally.',
    );
  });

  test('inline style transitions use the semantic duration scale', () => {
    const allowedDurations = new Set(transitionDurationTokens().values());
    const offenders = SOURCE_FILES.flatMap((file) =>
      inlineTransitions(file).flatMap(({ line, declaration, value }) =>
        declaration === 'transitionProperty'
          ? []
          : durationsInMs(value)
            .filter((duration) => !allowedDurations.has(duration))
            .map((duration) => `${relative(file)}:${line}: ${duration}ms`),
      ),
    );

    assert.deepEqual(
      offenders,
      [],
      `inline transitions must use a semantic duration (${[...allowedDurations].join(', ')}ms). `
        + 'Prefer Tailwind transition utilities so the scale remains visible to the guard.',
    );
  });

  test('only allowlisted files transition a layout property', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();

    for (const file of SOURCE_FILES) {
      for (const list of arbitraryTransitionLists(file)) {
        const layout = list.filter((property) => LAYOUT_PROPERTIES.includes(property));
        if (layout.length === 0) continue;

        const key = relative(file);
        seen.add(key);
        if (!(key in LAYOUT_TRANSITION_ALLOWLIST)) {
          offenders.push(`${key}: transitions ${layout.join(', ')}`);
        }
      }

      for (const { line, declaration, value } of inlineTransitions(file)) {
        if (declaration === 'transitionDuration') continue;
        const layout = transitionProperties(value).filter((property) => LAYOUT_PROPERTIES.includes(property));
        if (layout.length === 0) continue;

        const key = relative(file);
        seen.add(key);
        if (!(key in LAYOUT_TRANSITION_ALLOWLIST)) {
          offenders.push(`${key}:${line}: transitions ${layout.join(', ')}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'animating a layout property re-runs layout every frame. Prefer transform/opacity, '
        + 'or add the file to LAYOUT_TRANSITION_ALLOWLIST with the reason.',
    );

    const stale = Object.keys(LAYOUT_TRANSITION_ALLOWLIST).filter((key) => !seen.has(key));
    assert.deepEqual(stale, [], 'these files no longer animate layout — drop them from the allowlist');
  });

  test('non-repeating Tailwind animations stay within the overlay budget', () => {
    const animations = bracedBlock(TAILWIND_CONFIG, /^\s*animation\s*:/m);
    const slow = transitionDurationTokens().get('slow');
    assert.ok(slow, 'semantic motion scale has no slow/overlay duration');

    const entries = [...animations.matchAll(/['"]?([\w-]+)['"]?\s*:\s*(['"])(.*?)\2/g)]
      .map(([, name, , value]) => ({ name, value }));
    assert.ok(entries.length > 0, 'tailwind animation block has no parseable entries');
    assert.ok(entries.some(({ name }) => name === 'dialog-overlay-show'), 'dialog overlay animation is not pinned');
    assert.ok(entries.some(({ name }) => name === 'dialog-content-show'), 'dialog content animation is not pinned');

    const offenders: string[] = [];
    for (const { name, value } of entries) {
      for (const animation of splitTopLevelCommas(value)) {
        if (/\binfinite\b/.test(animation)) continue;
        const durations = durationsInMs(animation);
        assert.ok(durations.length > 0, `${name} has no parseable animation duration: ${animation}`);
        for (const durationMs of durations) {
          if (durationMs > slow) {
            offenders.push(`${name}: ${durationMs}ms`);
          }
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `one-shot animations must stay within the ${slow}ms overlay budget`,
    );
  });

  test('the repeating list rows animate nothing that costs layout', () => {
    for (const row of LIST_ROWS) {
      const file = path.join(SRC, row);
      const lists = arbitraryTransitionLists(file);
      const layout = lists.flat().filter((property) => LAYOUT_PROPERTIES.includes(property));
      assert.deepEqual(layout, [], `${row} animates ${layout.join(', ')} on a row that repeats per item`);
    }
  });

  test('prefers-reduced-motion still suppresses transitions and animations', () => {
    const block = bracedBlock(CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);

    // The universal selector matters: a scale is only honoured if the override
    // reaches every element, not just the ones that opted into a utility.
    assert.match(block, /\*,/);
    assert.match(block, /transition-duration:\s*0\.01ms\s*!important/);
    assert.match(block, /animation-duration:\s*0\.01ms\s*!important/);
  });
});
