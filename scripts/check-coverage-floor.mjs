#!/usr/bin/env node
// scripts/check-coverage-floor.mjs
//
// Coverage floor gate for CI. Follow-up to #101 / PR #184 (see issue #185,
// part 2). PR #184 emitted a coverage summary but never *failed* on a drop;
// this script turns that summary into a gate.
//
// WHAT IT DOES
//   Parses the machine-readable LCOV report each test suite emits and exits
//   non-zero if a suite's aggregate LINE coverage falls below its floor. It
//   parses LCOV rather than scraping Node's `--experimental-test-coverage` or
//   vitest's human-readable table because those tables are brittle to format
//   drift. The LCOV `LF`/`LH` totals reproduce the reported "all files" line %
//   exactly (verified while writing this: server 82.73%, unit 87.80%,
//   component 4.32% matched both sources to the reported precision).
//
// WHERE THE REPORTS COME FROM (produced by the coverage npm scripts):
//   coverage/server.lcov         <- npm run test:server:coverage    (node:test)
//   coverage/unit.lcov           <- npm run test:unit:coverage      (node:test)
//   coverage/component/lcov.info <- npm run test:component:coverage  (vitest v8)
//   Run `npm run test:coverage` (or the individual scripts) first; this script
//   only reads the reports, it does not run the tests.
//
// HOW TO BUMP THE FLOORS ("ratchet up as coverage grows" — issue #185)
//   When a suite's real coverage climbs, raise its `floor` below, leaving a
//   couple of points of headroom so an unrelated PR isn't blocked by noise.
//   NEVER lower a floor just to make a red run pass — investigate the
//   regression instead. Each suite has its own floor so a near-miss in one
//   area does not block work in another.
//   Real line coverage at time of writing (2026-07, after the #203/#205/#206/
//   #207/#208/#210 coverage batch landed): server ~82.7%, unit ~87.8%,
//   component ~4.3%.
//
// USAGE
//   node scripts/check-coverage-floor.mjs                 # check every suite
//   node scripts/check-coverage-floor.mjs server          # check one suite
//   node scripts/check-coverage-floor.mjs --self-test     # parser self-tests
//   node scripts/check-coverage-floor.mjs --lcov <path> --floor <n> [--label X]
//                                                         # check an explicit report

import { readFileSync, existsSync } from 'node:fs';

/**
 * Per-suite floors. Keep these as separate, tunable numbers (issue #185).
 * `floor` is the minimum acceptable aggregate LINE coverage percentage.
 */
const SUITES = {
  server: {
    label: 'Server (node:test)',
    lcov: 'coverage/server.lcov',
    floor: 80,
  },
  unit: {
    label: 'Front-end unit (node:test)',
    lcov: 'coverage/unit.lcov',
    floor: 85,
  },
  component: {
    label: 'Front-end component (vitest)',
    lcov: 'coverage/component/lcov.info',
    // The vitest suite instruments every src file (`include: src/**`) but only a
    // handful have specs so far, so this floor is deliberately low. Ratchet it
    // up aggressively as component specs land.
    floor: 3,
  },
};

/**
 * Aggregate LINE coverage from LCOV text. Sums the `LF` (lines found) and `LH`
 * (lines hit) records across every `SF` section and returns { lf, lh, pct }.
 *
 * Fails LOUD (throws) when the report has no `LF` records or zero instrumented
 * lines — that means coverage never ran, the report is empty, or the format
 * drifted, and we must NOT let a broken report pass silently at 0/0.
 *
 * @param {string} text raw LCOV report contents
 * @returns {{ lf: number, lh: number, pct: number }}
 */
export function parseLcovLineCoverage(text) {
  let lf = 0;
  let lh = 0;
  let sawLf = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('LF:')) {
      lf += Number(line.slice(3));
      sawLf = true;
    } else if (line.startsWith('LH:')) {
      lh += Number(line.slice(3));
    }
  }
  if (!sawLf) {
    throw new Error('no "LF:" records found — not a valid/complete LCOV report');
  }
  if (!Number.isFinite(lf) || !Number.isFinite(lh)) {
    throw new Error('LCOV LF/LH totals are not finite numbers');
  }
  if (lf === 0) {
    throw new Error('LCOV reports 0 instrumented lines (LF total is 0)');
  }
  return { lf, lh, pct: (100 * lh) / lf };
}

/**
 * Check one report file against a floor. Prints a pass/fail line and returns
 * true on pass, false on any failure (below floor, missing file, unparseable).
 */
function checkReport({ label, lcov, floor }) {
  if (!existsSync(lcov)) {
    console.error(
      `✗ ${label}: coverage report not found at "${lcov}". ` +
        'Did the coverage step run? Refusing to pass without a report.',
    );
    return false;
  }
  let result;
  try {
    result = parseLcovLineCoverage(readFileSync(lcov, 'utf8'));
  } catch (err) {
    console.error(`✗ ${label}: could not read coverage from "${lcov}": ${err.message}`);
    return false;
  }
  const pct = result.pct;
  const shown = pct.toFixed(2);
  if (pct < floor) {
    console.error(
      `✗ ${label}: ${shown}% line coverage is BELOW the ${floor}% floor ` +
        `(${result.lh}/${result.lf} lines).`,
    );
    return false;
  }
  console.log(
    `✓ ${label}: ${shown}% line coverage ≥ ${floor}% floor ` +
      `(${result.lh}/${result.lf} lines).`,
  );
  return true;
}

/** Minimal parser self-tests (issue #185 asks for a couple). */
function runSelfTests() {
  let failures = 0;
  const assert = (cond, msg) => {
    if (cond) {
      console.log(`✓ self-test: ${msg}`);
    } else {
      console.error(`✗ self-test FAILED: ${msg}`);
      failures += 1;
    }
  };
  const assertThrows = (fn, msg) => {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    assert(threw, msg);
  };

  // Sums LF/LH across multiple SF sections: (8+2) / (10+10) = 50%.
  const two = 'SF:a.ts\nLF:10\nLH:8\nend_of_record\nSF:b.ts\nLF:10\nLH:2\nend_of_record\n';
  assert(parseLcovLineCoverage(two).pct === 50, 'two files aggregate to 50%');

  // Single file: 3/4 = 75%.
  assert(parseLcovLineCoverage('SF:c.ts\nLF:4\nLH:3\nend_of_record\n').pct === 75, 'single file is 75%');

  // Full coverage: 5/5 = 100%.
  assert(parseLcovLineCoverage('SF:d.ts\nLF:5\nLH:5\nend_of_record\n').pct === 100, 'fully-covered file is 100%');

  // Loud failures on degenerate input.
  assertThrows(() => parseLcovLineCoverage(''), 'empty report throws');
  assertThrows(() => parseLcovLineCoverage('SF:e.ts\nend_of_record\n'), 'report with no LF throws');
  assertThrows(() => parseLcovLineCoverage('SF:f.ts\nLF:0\nLH:0\nend_of_record\n'), 'zero instrumented lines throws');

  if (failures > 0) {
    console.error(`\nself-tests: ${failures} failed`);
    process.exit(1);
  }
  console.log('\nself-tests: all passed');
}

function parseArgs(argv) {
  const opts = { lcov: null, floor: null, label: null, area: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lcov') opts.lcov = argv[(i += 1)];
    else if (arg === '--floor') opts.floor = Number(argv[(i += 1)]);
    else if (arg === '--label') opts.label = argv[(i += 1)];
    else if (!arg.startsWith('--')) opts.area = arg;
  }
  return opts;
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--self-test')) {
    runSelfTests();
    return;
  }

  const opts = parseArgs(argv);

  // Explicit report mode: --lcov <path> --floor <n> [--label <name>].
  if (opts.lcov !== null || opts.floor !== null) {
    if (opts.lcov === null || opts.floor === null || Number.isNaN(opts.floor)) {
      console.error('usage: --lcov <path> --floor <number> [--label <name>]');
      process.exit(2);
    }
    const ok = checkReport({
      label: opts.label ?? opts.lcov,
      lcov: opts.lcov,
      floor: opts.floor,
    });
    process.exit(ok ? 0 : 1);
  }

  // Configured-suite mode: a single area, or all of them.
  let suites;
  if (opts.area) {
    if (!SUITES[opts.area]) {
      console.error(`unknown suite "${opts.area}". Known: ${Object.keys(SUITES).join(', ')}`);
      process.exit(2);
    }
    suites = [SUITES[opts.area]];
  } else {
    suites = Object.values(SUITES);
  }

  let allOk = true;
  for (const suite of suites) {
    if (!checkReport(suite)) allOk = false;
  }

  if (!allOk) {
    console.error('\nCoverage floor check FAILED. See lines marked ✗ above.');
    process.exit(1);
  }
  console.log('\nCoverage floor check passed.');
}

main();
