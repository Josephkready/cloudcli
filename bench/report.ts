/**
 * Aggregation and presentation for benchmark results.
 *
 * Kept separate from `run.ts` so the same shaping can be applied to a JSON
 * report loaded from disk — which is what `--compare` does when it prints a
 * before/after table without re-running the baseline.
 */

import { round, relativeDelta, summarize } from './stats.js';
import type { BenchReport, FlowIteration, FlowResult, StepSample, Summary } from './types.js';
import type { Flow } from './flows.js';

/** Folds N iterations of one flow into a `FlowResult`. */
export function aggregateFlow(flow: Flow, iterations: FlowIteration[]): FlowResult {
  const totals = iterations.map((iteration) => iteration.totalMs);

  const steps = flow.steps.map((definition) => {
    const samples: StepSample[] = iterations
      .map((iteration) => iteration.steps.find((step) => step.step === definition.id))
      .filter((sample): sample is StepSample => sample !== undefined);

    // Endpoint costs are aggregated across iterations by path, because the
    // question a reader has here is "which call is expensive", not "what did
    // call #3 of iteration #2 cost".
    const byUrl = new Map<string, number[]>();
    for (const sample of samples) {
      for (const request of sample.requests) {
        const bucket = byUrl.get(request.url) ?? [];
        bucket.push(request.ms);
        byUrl.set(request.url, bucket);
      }
    }

    const api = [...byUrl.entries()]
      .map(([url, durations]) => {
        const summary = summarize(durations);
        return {
          url,
          calls: durations.length,
          medianMs: round(summary.median),
          totalMs: round(durations.reduce((total, value) => total + value, 0)),
        };
      })
      // Slowest first: the top row is the one worth attacking.
      .sort((left, right) => right.totalMs - left.totalMs);

    return {
      step: definition.id,
      description: definition.description,
      duration: summarize(samples.map((sample) => sample.ms)),
      blocking: summarize(samples.map((sample) => sample.blockingMs)),
      api,
    };
  });

  return { flow: flow.id, description: flow.description, total: summarize(totals), steps };
}

const pad = (value: string, width: number) => value.padEnd(width);
const padStart = (value: string, width: number) => value.padStart(width);
const ms = (value: number) => (Number.isFinite(value) ? `${round(value)}` : '—');

/** Console table for a single run. */
export function renderReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`cloudcli end-to-end benchmark — ${report.label}`);
  lines.push(
    `  ${report.fixture.totals.projects} projects · ${report.fixture.totals.sessions} conversations · ` +
    `${report.fixture.totals.rows.toLocaleString()} transcript rows · ` +
    `${(report.fixture.totals.bytes / 1024 / 1024).toFixed(1)} MB on disk`,
  );
  lines.push(
    `  ${report.config.iterations} iterations (+${report.config.warmup} warmup) · ` +
    `${report.environment.browser} · node ${report.environment.node} · ${report.environment.cpus} cpus · ` +
    `load ${report.environment.loadAverage.atStart}→${report.environment.loadAverage.atEnd}`,
  );
  lines.push('');

  const nameWidth = 46;
  lines.push(
    `  ${pad('flow / step', nameWidth)}${padStart('median', 10)}${padStart('p95', 10)}` +
    `${padStart('min', 10)}${padStart('blocked', 10)}`,
  );
  lines.push(`  ${'─'.repeat(nameWidth + 40)}`);

  for (const flow of report.flows) {
    lines.push(
      `  ${pad(flow.flow, nameWidth)}${padStart(ms(flow.total.median), 10)}` +
      `${padStart(ms(flow.total.p95), 10)}${padStart(ms(flow.total.min), 10)}${padStart('', 10)}`,
    );
    for (const step of flow.steps) {
      lines.push(
        `  ${pad(`    ${step.step}`, nameWidth)}${padStart(ms(step.duration.median), 10)}` +
        `${padStart(ms(step.duration.p95), 10)}${padStart(ms(step.duration.min), 10)}` +
        `${padStart(ms(step.blocking.median), 10)}`,
      );
      for (const call of step.api.slice(0, 3)) {
        lines.push(`  ${pad(`        ${call.url} ×${call.calls}`, nameWidth)}${padStart(ms(call.medianMs), 10)}`);
      }
    }
    lines.push('');
  }

  lines.push('  All times in milliseconds. "blocked" is main-thread long-task time inside the step.');
  lines.push('  Indented rows under a step are the API calls it made (median per call, top 3).');
  return lines.join('\n');
}

const formatDelta = (delta: number | null): string => {
  if (delta === null) {
    return '—';
  }
  const percent = delta * 100;
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(1)}%`;
};

/**
 * Before/after table. Negative percentages are improvements.
 *
 * Reports the delta twice — on the median and on the fastest observed run —
 * because the two answer different questions on a machine that is not
 * dedicated. The median moves with whatever else the box was doing; the minimum
 * is the closest thing available to "this run, with nothing in the way", so when
 * the two disagree it is usually the median that is describing the neighbours
 * rather than the change. Both are printed rather than picking one, since a win
 * that only shows up in the minimum is a weaker claim than one visible in both.
 */
export function renderComparison(baseline: BenchReport, current: BenchReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`comparison — ${baseline.label} → ${current.label}`);
  if (baseline.fixture.seed !== current.fixture.seed || baseline.fixture.profile !== current.fixture.profile) {
    // Worth shouting about: a delta across different fixtures is not a delta at
    // all, and the shapes are similar enough that it is an easy mistake to make.
    lines.push(
      `  WARNING: fixtures differ (${baseline.fixture.profile}/${baseline.fixture.seed} vs ` +
      `${current.fixture.profile}/${current.fixture.seed}) — these numbers are not comparable.`,
    );
  }
  lines.push(
    `  load average: ${baseline.label} ${baseline.environment.loadAverage.atStart}→${baseline.environment.loadAverage.atEnd}, ` +
    `${current.label} ${current.environment.loadAverage.atStart}→${current.environment.loadAverage.atEnd}`,
  );
  lines.push('');

  const nameWidth = 44;
  lines.push(
    `  ${pad('flow / step', nameWidth)}${padStart('med before', 11)}${padStart('med after', 11)}` +
    `${padStart('Δ med', 9)}${padStart('min before', 12)}${padStart('min after', 11)}${padStart('Δ min', 9)}`,
  );
  lines.push(`  ${'─'.repeat(nameWidth + 63)}`);

  const row = (
    label: string,
    before: Summary,
    after: Summary,
  ): string =>
    `  ${pad(label, nameWidth)}${padStart(ms(before.median), 11)}${padStart(ms(after.median), 11)}` +
    `${padStart(formatDelta(relativeDelta(before.median, after.median)), 9)}` +
    `${padStart(ms(before.min), 12)}${padStart(ms(after.min), 11)}` +
    `${padStart(formatDelta(relativeDelta(before.min, after.min)), 9)}`;

  for (const flow of current.flows) {
    const before = baseline.flows.find((candidate) => candidate.flow === flow.flow);
    if (!before) {
      lines.push(`  ${pad(flow.flow, nameWidth)}${padStart('—', 11)}${padStart(ms(flow.total.median), 11)}${padStart('new', 9)}`);
      continue;
    }

    lines.push(row(flow.flow, before.total, flow.total));

    for (const step of flow.steps) {
      const beforeStep = before.steps.find((candidate) => candidate.step === step.step);
      if (!beforeStep) continue;
      lines.push(row(`    ${step.step}`, beforeStep.duration, step.duration));
    }
    lines.push('');
  }

  lines.push('  Negative deltas are faster. "min" is the fastest of the measured iterations —');
  lines.push('  the statistic least polluted by other load on the machine.');
  return lines.join('\n');
}

/** Markdown version of the comparison, for pasting into a PR description. */
export function renderMarkdown(current: BenchReport, baseline: BenchReport | null): string {
  const lines: string[] = [];
  lines.push(`# cloudcli end-to-end benchmark — ${current.label}`);
  lines.push('');
  lines.push(
    `Fixture: **${current.fixture.profile}** (seed ${current.fixture.seed}) — ` +
    `${current.fixture.totals.projects} projects, ${current.fixture.totals.sessions} conversations, ` +
    `${current.fixture.totals.rows.toLocaleString()} transcript rows ` +
    `(${(current.fixture.totals.bytes / 1024 / 1024).toFixed(1)} MB).`,
  );
  lines.push('');
  lines.push(
    `${current.config.iterations} iterations (+${current.config.warmup} warmup) on ` +
    `${current.environment.browser}, node ${current.environment.node}, ${current.environment.cpus} CPUs.`,
  );
  lines.push('');

  if (baseline) {
    lines.push('| flow | median before | median after | Δ median | min before | min after | Δ min |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const flow of current.flows) {
      const before = baseline.flows.find((candidate) => candidate.flow === flow.flow);
      lines.push(
        `| \`${flow.flow}\` | ${before ? `${ms(before.total.median)} ms` : '—'} | ` +
        `${ms(flow.total.median)} ms | ${before ? formatDelta(relativeDelta(before.total.median, flow.total.median)) : 'new'} | ` +
        `${before ? `${ms(before.total.min)} ms` : '—'} | ${ms(flow.total.min)} ms | ` +
        `${before ? formatDelta(relativeDelta(before.total.min, flow.total.min)) : 'new'} |`,
      );
    }
  } else {
    lines.push('| flow | median | p95 | min |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const flow of current.flows) {
      lines.push(`| \`${flow.flow}\` | ${ms(flow.total.median)} ms | ${ms(flow.total.p95)} ms | ${ms(flow.total.min)} ms |`);
    }
  }

  lines.push('');
  for (const flow of current.flows) {
    lines.push(`### \`${flow.flow}\``);
    lines.push('');
    lines.push(flow.description);
    lines.push('');
    lines.push('| step | median | p95 | main-thread blocked |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const step of flow.steps) {
      lines.push(
        `| ${step.step} | ${ms(step.duration.median)} ms | ${ms(step.duration.p95)} ms | ` +
        `${ms(step.blocking.median)} ms |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
