import { FactExtractorService } from './fact-extractor.service';

const CHEAP_MODEL = 'openrouter/google/gemma-4-26b-a4b-it:free';

const aiReturning = (payload: unknown, degraded = false) => ({
  complete: jest.fn(async () => ({
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    modelUsed: CHEAP_MODEL,
    degraded,
  })),
});

describe('FactExtractorService', () => {
  it('extracts facts with positions assigned in order', async () => {
    const ai = aiReturning({
      facts: [
        { kind: 'role', text: 'Senior Developer at X', payload: { company: 'X' }, metric: null },
        { kind: 'achievement', text: 'Cut churn 23%', payload: {}, metric: '23%' },
      ],
    });

    const facts = await new FactExtractorService(ai as never).extract('# CV\n- Senior Developer at X\n- Cut churn 23%');

    expect(facts.map((f) => f.position)).toEqual([0, 1]);
    expect(facts[1].metric).toBe('23%');
    expect(facts[0].kind).toBe('role');
  });

  it('uses the cheap tier', async () => {
    const ai = aiReturning({ facts: [] });

    await new FactExtractorService(ai as never).extract('# CV');

    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ tier: 'cheap' }));
  });

  it('raises on unparseable model output rather than returning no facts', async () => {
    const ai = aiReturning('not json at all');

    // Zero facts and a broken parse are different outcomes and must stay distinguishable.
    await expect(new FactExtractorService(ai as never).extract('# CV')).rejects.toThrow(/parse/i);
  });

  it('raises when the payload has no facts array', async () => {
    const ai = aiReturning({ notFacts: [] });

    await expect(new FactExtractorService(ai as never).extract('# CV')).rejects.toThrow(/facts/);
  });

  it('returns an empty array for a genuinely empty CV', async () => {
    const ai = aiReturning({ facts: [] });

    await expect(new FactExtractorService(ai as never).extract('# CV')).resolves.toEqual([]);
  });

  it('rejects a fact whose kind is not recognised', async () => {
    const ai = aiReturning({ facts: [{ kind: 'invented', text: 'x', payload: {}, metric: null }] });

    await expect(new FactExtractorService(ai as never).extract('# CV')).rejects.toThrow(/kind/);
  });

  it('rejects a fact with no text, since an empty fact grounds nothing', async () => {
    const ai = aiReturning({ facts: [{ kind: 'skill', text: '   ', payload: {}, metric: null }] });

    await expect(new FactExtractorService(ai as never).extract('# CV')).rejects.toThrow(/text/i);
  });

  it('tolerates a fenced JSON code block, which models routinely emit', async () => {
    const ai = aiReturning('```json\n{"facts":[{"kind":"skill","text":"Python","payload":{},"metric":null}]}\n```');

    const facts = await new FactExtractorService(ai as never).extract('# CV');

    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe('Python');
  });

  it('defaults missing payload and metric rather than rejecting the fact', async () => {
    const ai = aiReturning({ facts: [{ kind: 'skill', text: 'Python' }] });

    const facts = await new FactExtractorService(ai as never).extract('# CV');

    expect(facts[0].payload).toEqual({});
    expect(facts[0].metric).toBeNull();
  });

  it('raises when extraction ran on a degraded model', async () => {
    const ai = aiReturning({ facts: [{ kind: 'skill', text: 'Python', payload: {}, metric: null }] }, true);

    // A downgraded model silently produces a worse fact graph, and every later stage
    // trusts it. Refuse rather than persist facts of unknown quality.
    await expect(new FactExtractorService(ai as never).extract('# CV')).rejects.toThrow(/degraded/i);
  });

  it('raises rather than returning facts when the markdown is empty', async () => {
    const ai = aiReturning({ facts: [] });

    await expect(new FactExtractorService(ai as never).extract('   ')).rejects.toThrow(/empty/i);
    expect(ai.complete).not.toHaveBeenCalled();
  });
});
