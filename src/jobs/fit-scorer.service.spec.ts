import { FitScorerService } from './fit-scorer.service';
import { Requirement } from './job.types';

const SMART_MODEL = 'openrouter/google/gemma-4-31b-it:free';

const aiReturning = (payload: unknown, degraded = false) => ({
  complete: jest.fn(async () => ({
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    modelUsed: SMART_MODEL,
    degraded,
  })),
});

const req = (text: string, kind: 'must' | 'nice' = 'must'): Requirement => ({
  text,
  kind,
  category: 'general',
});

const facts = [
  { factId: 'f1', text: 'Built services in TypeScript', kind: 'achievement' },
  { factId: 'f2', text: 'Ran PostgreSQL in production', kind: 'achievement' },
] as never[];

describe('FitScorerService', () => {
  it('marks a requirement met when a fact supports it and cites the factId', async () => {
    const ai = aiReturning({
      assessments: [{ requirement: 'TypeScript', verdict: 'met', factIds: ['f1'], evidence: 'Built services in TS' }],
    });

    const report = await new FitScorerService(ai as never).score([req('TypeScript')], facts);

    expect(report.matches).toHaveLength(1);
    expect(report.matches[0].factIds).toEqual(['f1']);
    expect(report.matches[0].verdict).toBe('met');
  });

  it('marks a requirement missing when no fact supports it', async () => {
    const ai = aiReturning({
      assessments: [{ requirement: 'Rust', verdict: 'missing', factIds: [], evidence: null }],
    });

    const report = await new FitScorerService(ai as never).score([req('Rust')], facts);

    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].verdict).toBe('missing');
  });

  it('weights an unmet must far more heavily than an unmet nice', async () => {
    const missMust = aiReturning({
      assessments: [
        { requirement: 'A', verdict: 'missing', factIds: [], evidence: null },
        { requirement: 'B', verdict: 'met', factIds: ['f1'], evidence: 'x' },
      ],
    });
    const missNice = aiReturning({
      assessments: [
        { requirement: 'A', verdict: 'met', factIds: ['f1'], evidence: 'x' },
        { requirement: 'B', verdict: 'missing', factIds: [], evidence: null },
      ],
    });

    const withMustMissing = await new FitScorerService(missMust as never).score(
      [req('A', 'must'), req('B', 'nice')],
      facts,
    );
    const withNiceMissing = await new FitScorerService(missNice as never).score(
      [req('A', 'must'), req('B', 'nice')],
      facts,
    );

    expect(withNiceMissing.score).toBeGreaterThan(withMustMissing.score);
  });

  it('scores 100 when every requirement is met', async () => {
    const ai = aiReturning({
      assessments: [{ requirement: 'TypeScript', verdict: 'met', factIds: ['f1'], evidence: 'x' }],
    });

    expect((await new FitScorerService(ai as never).score([req('TypeScript')], facts)).score).toBe(100);
  });

  it('scores 0 when nothing is met', async () => {
    const ai = aiReturning({
      assessments: [{ requirement: 'Rust', verdict: 'missing', factIds: [], evidence: null }],
    });

    expect((await new FitScorerService(ai as never).score([req('Rust')], facts)).score).toBe(0);
  });

  it('gives partial credit for a partial verdict', async () => {
    const ai = aiReturning({
      assessments: [{ requirement: 'Kubernetes', verdict: 'partial', factIds: ['f2'], evidence: 'adjacent' }],
    });

    const report = await new FitScorerService(ai as never).score([req('Kubernetes')], facts);

    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThan(100);
  });

  it('never cites a factId that is not in the supplied facts', async () => {
    const ai = aiReturning({
      assessments: [
        { requirement: 'TypeScript', verdict: 'met', factIds: ['f1', 'f-invented'], evidence: 'x' },
      ],
    });

    const report = await new FitScorerService(ai as never).score([req('TypeScript')], facts);

    // A hallucinated citation would make the gap report untrustworthy, which is the
    // entire value of showing evidence rather than only a number.
    expect(report.matches[0].factIds).toEqual(['f1']);
  });

  it('downgrades a met verdict to missing when every cited fact was invented', async () => {
    const ai = aiReturning({
      assessments: [{ requirement: 'Rust', verdict: 'met', factIds: ['f-invented'], evidence: 'nope' }],
    });

    const report = await new FitScorerService(ai as never).score([req('Rust')], facts);

    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].verdict).toBe('missing');
  });

  it('raises when scoring ran on a degraded model', async () => {
    const ai = aiReturning({ assessments: [] }, true);

    await expect(new FitScorerService(ai as never).score([req('A')], facts)).rejects.toThrow(/degraded/i);
  });

  it('returns every requirement across matches and gaps, losing none', async () => {
    const ai = aiReturning({
      assessments: [
        { requirement: 'A', verdict: 'met', factIds: ['f1'], evidence: 'x' },
        { requirement: 'B', verdict: 'missing', factIds: [], evidence: null },
      ],
    });

    const report = await new FitScorerService(ai as never).score([req('A'), req('B')], facts);

    expect(report.matches.length + report.gaps.length).toBe(2);
  });

  it('treats a requirement the model skipped as missing rather than dropping it', async () => {
    const ai = aiReturning({ assessments: [{ requirement: 'A', verdict: 'met', factIds: ['f1'], evidence: 'x' }] });

    const report = await new FitScorerService(ai as never).score([req('A'), req('B')], facts);

    // Silently losing a requirement would inflate the score.
    expect(report.matches.length + report.gaps.length).toBe(2);
    expect(report.gaps.map((g) => g.requirement.text)).toContain('B');
  });

  it('handles a CV with no facts without crashing', async () => {
    const ai = aiReturning({
      assessments: [{ requirement: 'A', verdict: 'missing', factIds: [], evidence: null }],
    });

    const report = await new FitScorerService(ai as never).score([req('A')], []);

    expect(report.score).toBe(0);
  });

  it('scores 100 for a posting with no stated requirements without calling the model', async () => {
    const ai = aiReturning({ assessments: [] });

    const report = await new FitScorerService(ai as never).score([], facts);

    expect(report.score).toBe(100);
    expect(ai.complete).not.toHaveBeenCalled();
  });
});
