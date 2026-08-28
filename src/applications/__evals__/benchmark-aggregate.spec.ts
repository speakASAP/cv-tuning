import { aggregateByTier, buildReport, formatReportJson, formatReportMarkdown } from './benchmark-aggregate';
import { BenchmarkRunResult } from './benchmark-aggregate';

const base: BenchmarkRunResult = {
  fixture: 'candidate-a',
  tier: 'smart',
  model: 'openrouter/google/gemma-4-31b-it:free',
  degraded: false,
  tailorLatencyMs: 1000,
  entailLatencyMs: 500,
  totalLatencyMs: 1500,
  bullets: 3,
  supported: 3,
  overreach: 0,
  unsupported: 0,
  dropped: 0,
  aiTell: 10,
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  costUsd: null,
  error: '',
  skipped: false,
};

describe('aggregateByTier', () => {
  it('computes count, avg, and median latency for a completed tier', () => {
    const results: BenchmarkRunResult[] = [
      { ...base, fixture: 'a', totalLatencyMs: 1000 },
      { ...base, fixture: 'b', totalLatencyMs: 2000 },
      { ...base, fixture: 'c', totalLatencyMs: 3000 },
    ];

    const [aggregate] = aggregateByTier(results);

    expect(aggregate.tier).toBe('smart');
    expect(aggregate.runs).toBe(3);
    expect(aggregate.completed).toBe(3);
    expect(aggregate.errors).toBe(0);
    expect(aggregate.avgTotalLatencyMs).toBe(2000);
    expect(aggregate.medianTotalLatencyMs).toBe(2000);
  });

  it('excludes errored and skipped runs from averages but counts them separately', () => {
    const results: BenchmarkRunResult[] = [
      { ...base, fixture: 'a', totalLatencyMs: 1000 },
      { ...base, fixture: 'b', error: 'boom', totalLatencyMs: 0, skipped: false },
      { ...base, fixture: 'c', tier: 'premium', error: 'premium not configured', skipped: true, totalLatencyMs: 0 },
    ];

    const aggregates = aggregateByTier(results);
    const smart = aggregates.find((a) => a.tier === 'smart')!;
    const premium = aggregates.find((a) => a.tier === 'premium')!;

    expect(smart.runs).toBe(2);
    expect(smart.completed).toBe(1);
    expect(smart.errors).toBe(1);
    expect(smart.avgTotalLatencyMs).toBe(1000);

    expect(premium.runs).toBe(1);
    expect(premium.completed).toBe(0);
    expect(premium.skipped).toBe(1);
    expect(premium.errors).toBe(0);
    expect(premium.avgTotalLatencyMs).toBeNull();
  });

  it('sums grounding counts only across completed runs', () => {
    const results: BenchmarkRunResult[] = [
      { ...base, fixture: 'a', supported: 2, overreach: 1, unsupported: 0, dropped: 1 },
      { ...base, fixture: 'b', error: 'boom', supported: 99, overreach: 99, unsupported: 99, dropped: 99 },
    ];

    const [aggregate] = aggregateByTier(results);

    expect(aggregate.totalSupported).toBe(2);
    expect(aggregate.totalOverreach).toBe(1);
    expect(aggregate.totalUnsupported).toBe(0);
    expect(aggregate.totalDropped).toBe(1);
  });

  it('treats token/cost fields as null when upstream never reports them', () => {
    const [aggregate] = aggregateByTier([{ ...base }]);

    expect(aggregate.totalTokens).toBeNull();
    expect(aggregate.totalCostUsd).toBeNull();
  });

  it('sums token/cost fields when upstream reports them, distinguishing from an absent value', () => {
    const results: BenchmarkRunResult[] = [
      { ...base, fixture: 'a', totalTokens: 100, costUsd: 0.01 },
      { ...base, fixture: 'b', totalTokens: 200, costUsd: 0.02 },
      { ...base, fixture: 'c', totalTokens: null, costUsd: null },
    ];

    const [aggregate] = aggregateByTier(results);

    expect(aggregate.totalTokens).toBe(300);
    expect(aggregate.totalCostUsd).toBeCloseTo(0.03);
  });

  it('produces one aggregate row per distinct tier present in the results', () => {
    const results: BenchmarkRunResult[] = [
      { ...base, tier: 'cheap' },
      { ...base, tier: 'smart' },
      { ...base, tier: 'premium', skipped: true, error: 'premium not configured' },
    ];

    const aggregates = aggregateByTier(results);
    expect(aggregates.map((a) => a.tier).sort()).toEqual(['cheap', 'premium', 'smart']);
  });
});

describe('buildReport / formatReportJson / formatReportMarkdown', () => {
  it('round-trips through JSON without losing per-run detail', () => {
    const report = buildReport([base], 1, '2026-08-28T00:00:00.000Z');
    const parsed = JSON.parse(formatReportJson(report));

    expect(parsed.generatedAt).toBe('2026-08-28T00:00:00.000Z');
    expect(parsed.fixtureCount).toBe(1);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.aggregates).toHaveLength(1);
  });

  it('renders a markdown report with a per-tier summary and a per-run detail table', () => {
    const report = buildReport([base], 1, '2026-08-28T00:00:00.000Z');
    const markdown = formatReportMarkdown(report);

    expect(markdown).toContain('# Phase 8 tier benchmark');
    expect(markdown).toContain('## Per-tier summary');
    expect(markdown).toContain('| smart |');
    expect(markdown).toContain('## Per-run detail');
    expect(markdown).toContain('candidate-a');
  });

  it('marks a skipped run distinctly from an errored one in the markdown detail table', () => {
    const skipped: BenchmarkRunResult = { ...base, tier: 'premium', skipped: true, error: 'premium not configured' };
    const errored: BenchmarkRunResult = { ...base, fixture: 'b', error: 'network boom' };
    const report = buildReport([skipped, errored], 1);
    const markdown = formatReportMarkdown(report);

    expect(markdown).toContain('SKIPPED: premium not configured');
    expect(markdown).toContain('network boom');
  });
});
