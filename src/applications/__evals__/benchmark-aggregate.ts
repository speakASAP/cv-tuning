/**
 * Aggregation and report formatting for the Phase 8 benchmark. Pure functions only — no
 * network, no filesystem — so this is unit-testable without a live ai-microservice
 * (`benchmark-aggregate.spec.ts`).
 */
import { BenchmarkTier } from './benchmark-client';

export interface BenchmarkRunResult {
  fixture: string;
  tier: BenchmarkTier;
  model: string;
  degraded: boolean;
  /** Latency of the tailoring call, the entailment call, and their sum. */
  tailorLatencyMs: number;
  entailLatencyMs: number;
  totalLatencyMs: number;
  bullets: number;
  supported: number;
  overreach: number;
  unsupported: number;
  dropped: number;
  aiTell: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  /** Non-empty when the run failed (network, parse, degraded-model refusal, or premium
   * not configured); every other field is zeroed in that case. */
  error: string;
  /** True only for the specific, expected "premium is not configured" skip — kept distinct
   * from `error` so a report can show "skipped" rather than count it as a failure. */
  skipped: boolean;
}

export interface TierAggregate {
  tier: BenchmarkTier;
  runs: number;
  errors: number;
  skipped: number;
  /** Runs that neither errored nor were skipped — the denominator for every average below. */
  completed: number;
  avgTotalLatencyMs: number | null;
  medianTotalLatencyMs: number | null;
  avgAiTell: number | null;
  totalBullets: number;
  totalSupported: number;
  totalOverreach: number;
  totalUnsupported: number;
  totalDropped: number;
  /** `null` when not a single completed run in this tier reported any tokens/cost — i.e.
   * upstream never exposed them, distinct from "exposed and zero". */
  totalPromptTokens: number | null;
  totalCompletionTokens: number | null;
  totalTokens: number | null;
  totalCostUsd: number | null;
}

const average = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/** Sums a nullable numeric field across runs; returns `null` only when NONE of the runs
 * reported a value, so "upstream never exposes this" stays distinguishable from "the sum
 * happens to be zero". */
const sumNullable = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, v) => sum + v, 0);
};

export function aggregateByTier(results: BenchmarkRunResult[]): TierAggregate[] {
  const tiers = Array.from(new Set(results.map((r) => r.tier)));

  return tiers.map((tier) => {
    const forTier = results.filter((r) => r.tier === tier);
    const errors = forTier.filter((r) => r.error && !r.skipped);
    const skipped = forTier.filter((r) => r.skipped);
    const completed = forTier.filter((r) => !r.error && !r.skipped);

    return {
      tier,
      runs: forTier.length,
      errors: errors.length,
      skipped: skipped.length,
      completed: completed.length,
      avgTotalLatencyMs: average(completed.map((r) => r.totalLatencyMs)),
      medianTotalLatencyMs: median(completed.map((r) => r.totalLatencyMs)),
      avgAiTell: average(completed.map((r) => r.aiTell)),
      totalBullets: completed.reduce((sum, r) => sum + r.bullets, 0),
      totalSupported: completed.reduce((sum, r) => sum + r.supported, 0),
      totalOverreach: completed.reduce((sum, r) => sum + r.overreach, 0),
      totalUnsupported: completed.reduce((sum, r) => sum + r.unsupported, 0),
      totalDropped: completed.reduce((sum, r) => sum + r.dropped, 0),
      totalPromptTokens: sumNullable(completed.map((r) => r.promptTokens)),
      totalCompletionTokens: sumNullable(completed.map((r) => r.completionTokens)),
      totalTokens: sumNullable(completed.map((r) => r.totalTokens)),
      totalCostUsd: sumNullable(completed.map((r) => r.costUsd)),
    };
  });
}

const fmt = (value: number | null, digits = 0): string => (value === null ? 'n/a' : value.toFixed(digits));

export interface BenchmarkReport {
  generatedAt: string;
  fixtureCount: number;
  results: BenchmarkRunResult[];
  aggregates: TierAggregate[];
}

export function buildReport(results: BenchmarkRunResult[], fixtureCount: number, generatedAt = new Date().toISOString()): BenchmarkReport {
  return { generatedAt, fixtureCount, results, aggregates: aggregateByTier(results) };
}

export function formatReportJson(report: BenchmarkReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatReportMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [
    `# Phase 8 tier benchmark — ${report.generatedAt}`,
    '',
    `${report.fixtureCount} fixture(s) evaluated. Full per-run detail is in the paired JSON ` +
      'file. This table is aggregated per tier and contains no fixture-identifying content.',
    '',
    '## Per-tier summary',
    '',
    '| tier | runs | completed | errors | skipped | avg latency (ms) | median latency (ms) | avg aiTell | unsupported | tokens | cost (USD) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];

  for (const a of report.aggregates) {
    lines.push(
      `| ${a.tier} | ${a.runs} | ${a.completed} | ${a.errors} | ${a.skipped} | ` +
        `${fmt(a.avgTotalLatencyMs)} | ${fmt(a.medianTotalLatencyMs)} | ${fmt(a.avgAiTell, 1)} | ` +
        `${a.totalUnsupported} | ${a.totalTokens === null ? 'n/a' : a.totalTokens} | ` +
        `${a.totalCostUsd === null ? 'n/a' : a.totalCostUsd.toFixed(4)} |`,
    );
  }

  lines.push('', '## Per-run detail', '', '| fixture | tier | model | degraded | latency (ms) | bullets | supported | overreach | unsupported | dropped | aiTell | error |', '|---|---|---|---|---|---|---|---|---|---|---|---|');

  for (const r of report.results) {
    lines.push(
      `| ${r.fixture} | ${r.tier} | ${r.model || 'n/a'} | ${r.degraded} | ${r.totalLatencyMs} | ` +
        `${r.bullets} | ${r.supported} | ${r.overreach} | ${r.unsupported} | ${r.dropped} | ` +
        `${r.aiTell} | ${r.skipped ? 'SKIPPED: ' + r.error : r.error || '—'} |`,
    );
  }

  return lines.join('\n') + '\n';
}
