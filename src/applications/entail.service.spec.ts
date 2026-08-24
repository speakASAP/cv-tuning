import { FactSnapshot } from './application.types';
import { EntailService } from './entail.service';

const SMART_MODEL = 'openrouter/google/gemma-4-31b-it:free';

const aiReturning = (payload: unknown, degraded = false) => ({
  complete: jest.fn(async (_req: { tier: string; userPrompt: string }) => ({
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    modelUsed: SMART_MODEL,
    degraded,
  })),
});

const facts: FactSnapshot[] = [
  { factId: 'f1', text: 'Senior Developer at Acme, 2019-2024', kind: 'role', section: 'Experience', org: 'Acme Corp', period: '2019-2024' },
  { factId: 'f2', text: 'Ran PostgreSQL in production', kind: 'achievement', section: 'Experience', org: 'Acme Corp', period: '2019-2024' },
];

const bullet = (text: string, sourceFactId = 'f1') => ({
  text,
  sourceFactId,
  targetRequirement: null,
});

describe('EntailService', () => {
  it('marks a faithful rewrite supported', async () => {
    const ai = aiReturning({ results: [{ bulletRef: 0, verdict: 'supported', span: null }] });

    const result = await new EntailService(ai as never).validate(
      [bullet('Senior Developer at Acme for five years')],
      facts,
    );

    expect(result.bullets[0].verdict).toBe('supported');
    expect(result.bullets[0].span).toBeNull();
  });

  it('marks an invented team size overreach and keeps the span', async () => {
    const ai = aiReturning({
      results: [{ bulletRef: 0, verdict: 'overreach', span: 'Led a team of 12' }],
    });

    const result = await new EntailService(ai as never).validate(
      [bullet('Led a team of 12 as Senior Developer at Acme')],
      facts,
    );

    expect(result.bullets[0].verdict).toBe('overreach');
    expect(result.bullets[0].span).toBe('Led a team of 12');
  });

  it('marks a wholly invented claim unsupported', async () => {
    const ai = aiReturning({
      results: [{ bulletRef: 0, verdict: 'unsupported', span: 'PhD in Physics' }],
    });

    const result = await new EntailService(ai as never).validate([bullet('PhD in Physics')], facts);

    expect(result.bullets[0].verdict).toBe('unsupported');
  });

  it('treats a bullet the model skipped as unsupported, never supported', async () => {
    const ai = aiReturning({ results: [{ bulletRef: 0, verdict: 'supported', span: null }] });

    const result = await new EntailService(ai as never).validate(
      [bullet('a'), bullet('b', 'f2')],
      facts,
    );

    // Fail closed. An unvalidated claim reaching the user as validated is the exact failure
    // this layer exists to prevent.
    expect(result.bullets).toHaveLength(2);
    expect(result.bullets[1].verdict).toBe('unsupported');
  });

  it('synthesizes a span when a non-supported verdict arrives without one', async () => {
    const ai = aiReturning({ results: [{ bulletRef: 0, verdict: 'overreach', span: null }] });

    const result = await new EntailService(ai as never).validate([bullet('Led a huge team')], facts);

    // A downgrade must never destroy the reason for it.
    expect(result.bullets[0].span).toBeTruthy();
  });

  it('ignores a result whose bulletRef is out of range rather than misattributing it', async () => {
    const ai = aiReturning({
      results: [
        { bulletRef: 0, verdict: 'supported', span: null },
        { bulletRef: 99, verdict: 'supported', span: null },
      ],
    });

    const result = await new EntailService(ai as never).validate([bullet('a')], facts);

    expect(result.bullets).toHaveLength(1);
    expect(result.bullets[0].verdict).toBe('supported');
  });

  it('treats an unrecognised verdict string as unsupported', async () => {
    const ai = aiReturning({ results: [{ bulletRef: 0, verdict: 'probably fine', span: null }] });

    const result = await new EntailService(ai as never).validate([bullet('a')], facts);

    expect(result.bullets[0].verdict).toBe('unsupported');
  });

  it('raises when the validator ran on a degraded model', async () => {
    const ai = aiReturning({ results: [] }, true);

    // A degraded validator is worse than a degraded generator: it silently stops catching
    // fabrication while still returning confident verdicts.
    await expect(new EntailService(ai as never).validate([bullet('a')], facts)).rejects.toThrow(
      /degraded/i,
    );
  });

  it('raises on malformed JSON rather than passing every bullet', async () => {
    const ai = aiReturning('not json');

    await expect(new EntailService(ai as never).validate([bullet('a')], facts)).rejects.toThrow(
      /parse/i,
    );
  });

  it('raises when the response has no results array', async () => {
    const ai = aiReturning({ nope: true });

    await expect(new EntailService(ai as never).validate([bullet('a')], facts)).rejects.toThrow(
      /results/i,
    );
  });

  it('returns nothing and calls no model when there are no bullets', async () => {
    const ai = aiReturning({ results: [] });

    const result = await new EntailService(ai as never).validate([], facts);

    expect(result.bullets).toEqual([]);
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('raises when a bullet cites a fact that is not in the snapshot', async () => {
    const ai = aiReturning({ results: [{ bulletRef: 0, verdict: 'supported', span: null }] });

    // TailorService should already have dropped this. Reaching here means the constraint
    // was bypassed, which must be loud rather than validated against nothing.
    await expect(
      new EntailService(ai as never).validate([bullet('a', 'f-missing')], facts),
    ).rejects.toThrow(/f-missing/);
  });

  it('sends each bullet with its own source fact text', async () => {
    const ai = aiReturning({ results: [{ bulletRef: 0, verdict: 'supported', span: null }] });

    await new EntailService(ai as never).validate([bullet('rewritten thing', 'f2')], facts);

    const prompt = ai.complete.mock.calls[0][0];
    expect(prompt.userPrompt).toContain('Ran PostgreSQL in production');
    expect(prompt.userPrompt).toContain('rewritten thing');
    expect(prompt.tier).toBe('smart');
  });

  it('reports the validator model separately from the generator', async () => {
    const ai = aiReturning({ results: [{ bulletRef: 0, verdict: 'supported', span: null }] });

    const result = await new EntailService(ai as never).validate([bullet('a')], facts);

    expect(result.validatorModelUsed).toBe(SMART_MODEL);
  });
});
