#!/usr/bin/env node
// scripts/coverage-all.mjs
//
// Whole-app line coverage: one number for every source file in `src/`,
// `server/` and `shared/`, including files no test ever imports.
//
// WHY A MERGE IS NEEDED
//   The three suites each see a slice of the app, and they count lines
//   differently:
//     - node:test (`coverage/server.lcov`, `coverage/unit.lcov`) only reports
//       files a test actually loaded, counts EVERY physical line (LF == wc -l,
//       blanks and comments included), and also reports the test files.
//     - vitest v8 (`coverage/component/lcov.info`) instruments every file that
//       matches `coverage.include` in vitest.config.ts — tested or not — and
//       counts only executable lines.
//   So vitest's per-file line set is the denominator: it exists for every
//   source file and is the only one that ignores blanks/comments. A line is
//   covered when ANY suite hit it (node:test DA lines are mapped back to the
//   original source by tsx's source maps, so line numbers agree).
//
// USAGE (after `npm run test:coverage`)
//   node scripts/coverage-all.mjs                 # summary + worst files
//   node scripts/coverage-all.mjs --floor 80      # also exit 1 below 80%
//   node scripts/coverage-all.mjs --files         # every file, worst first
//   node scripts/coverage-all.mjs --json out.json # machine-readable per-file
//   node scripts/coverage-all.mjs --self-test

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const BASE_REPORT = 'coverage/component/lcov.info';
const EXTRA_REPORTS = ['coverage/server.lcov', 'coverage/unit.lcov'];

/** Parse LCOV text into Map<relPath, Map<line, hits>>. Paths are normalized
 *  to repo-relative POSIX form so reports written from different cwds (or
 *  with absolute SF paths) merge onto the same key. */
export function parseLcovLines(text, root = ROOT) {
  const files = new Map();
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      let file = line.slice(3);
      if (path.isAbsolute(file)) file = path.relative(root, file);
      file = file.split(path.sep).join('/');
      current = files.get(file) ?? new Map();
      files.set(file, current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNo, hits] = line.slice(3).split(',');
      const n = Number(lineNo);
      const h = Number(hits);
      if (Number.isFinite(n) && Number.isFinite(h)) {
        current.set(n, Math.max(current.get(n) ?? 0, h));
      }
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  return files;
}

/** Only first-party app source counts toward the whole-app number. */
export function isAppSource(file) {
  if (!/^(src|server|shared)\//.test(file)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return false;
  if (file.endsWith('.d.ts')) return false;
  if (file.startsWith('src/test/')) return false;
  return true;
}

/** Merge: base defines each file's executable lines; a line is hit if the
 *  base or any extra report hit it. Returns per-file rows + totals. */
export function mergeCoverage(base, extras) {
  const rows = [];
  let lf = 0;
  let lh = 0;
  for (const [file, lines] of base) {
    if (!isAppSource(file)) continue;
    let hit = 0;
    for (const [lineNo, hits] of lines) {
      const covered = hits > 0 || extras.some((extra) => (extra.get(file)?.get(lineNo) ?? 0) > 0);
      if (covered) hit += 1;
    }
    const total = lines.size;
    lf += total;
    lh += hit;
    rows.push({ file, lf: total, lh: hit, pct: total === 0 ? 100 : (hit / total) * 100 });
  }
  return { rows, lf, lh, pct: lf === 0 ? 0 : (lh / lf) * 100 };
}

function summarizeByArea(rows) {
  const areas = new Map();
  for (const row of rows) {
    const area = row.file.split('/')[0];
    const agg = areas.get(area) ?? { lf: 0, lh: 0 };
    agg.lf += row.lf;
    agg.lh += row.lh;
    areas.set(area, agg);
  }
  return areas;
}

function runSelfTests() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`self-test failed: ${msg}`);
  };
  const base = parseLcovLines(
    ['SF:src/a.ts', 'DA:1,0', 'DA:2,0', 'DA:3,1', 'end_of_record',
      'SF:src/a.test.ts', 'DA:1,1', 'end_of_record',
      'SF:server/b.js', 'DA:5,0', 'end_of_record'].join('\n'),
  );
  const extra = parseLcovLines(
    [`SF:${path.join(ROOT, 'src/a.ts')}`, 'DA:1,4', 'DA:2,0', 'DA:9,7', 'end_of_record'].join('\n'),
  );
  const merged = mergeCoverage(base, [extra]);
  assert(merged.rows.length === 2, 'test files are excluded');
  assert(merged.lf === 4, 'denominator comes from the base report only');
  assert(merged.lh === 2, 'a line hit in any report counts once');
  assert(extra.has('src/a.ts'), 'absolute SF paths normalize to repo-relative');
  assert(!isAppSource('src/vite-env.d.ts'), '.d.ts excluded');
  assert(!isAppSource('e2e/foo.ts'), 'non-app trees excluded');
  console.log('coverage-all self-tests passed');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    runSelfTests();
    return;
  }
  const floorIdx = argv.indexOf('--floor');
  const floor = floorIdx >= 0 ? Number(argv[floorIdx + 1]) : null;
  const jsonIdx = argv.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;

  if (!existsSync(BASE_REPORT)) {
    console.error(`missing ${BASE_REPORT} — run \`npm run test:coverage\` first`);
    process.exit(2);
  }
  const base = parseLcovLines(readFileSync(BASE_REPORT, 'utf8'));
  const extras = EXTRA_REPORTS.filter((p) => {
    if (existsSync(p)) return true;
    console.warn(`warning: ${p} not found — its hits are not counted`);
    return false;
  }).map((p) => parseLcovLines(readFileSync(p, 'utf8')));

  const merged = mergeCoverage(base, extras);
  merged.rows.sort((a, b) => (b.lf - b.lh) - (a.lf - a.lh));

  const shown = argv.includes('--files') ? merged.rows : merged.rows.slice(0, 25);
  console.log('Uncovered  Lines   Pct  File');
  for (const row of shown) {
    console.log(`${String(row.lf - row.lh).padStart(9)} ${String(row.lf).padStart(6)} ${row.pct.toFixed(1).padStart(5)}  ${row.file}`);
  }
  console.log('');
  for (const [area, agg] of summarizeByArea(merged.rows)) {
    console.log(`${area.padEnd(8)} ${((agg.lh / agg.lf) * 100).toFixed(2)}%  (${agg.lh}/${agg.lf})`);
  }
  console.log(`ALL      ${merged.pct.toFixed(2)}%  (${merged.lh}/${merged.lf} lines, ${merged.rows.length} files)`);

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(merged, null, 2));
  if (floor !== null && merged.pct < floor) {
    console.error(`FAIL: whole-app line coverage ${merged.pct.toFixed(2)}% is below the ${floor}% floor`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
