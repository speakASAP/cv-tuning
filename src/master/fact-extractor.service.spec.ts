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

  it('derives section, org and period from the markdown headings, not from the model', async () => {
    // The model is never asked for the employer or the date range (spec §6): reporting
    // them is a fabrication surface on exactly the fields an employer judges a CV by.
    // They are walked out of the markdown structure in code instead.
    const ai = aiReturning({
      facts: [{ kind: 'achievement', text: 'Cut churn 23%', payload: {}, metric: '23%' }],
    });
    const markdown = [
      '# Jane Doe',
      '',
      '## Experience',
      '',
      '### Senior Developer — Acme Corp (2019 – 2024)',
      '',
      '- Cut churn 23%',
    ].join('\n');

    const [fact] = await new FactExtractorService(ai as never).extract(markdown);

    expect(fact.section).toBe('Experience');
    expect(fact.org).toBe('Acme Corp');
    expect(fact.period).toBe('2019 – 2024');
  });

  it('never asks the model for section, org or period', async () => {
    const ai = aiReturning({ facts: [] });

    await new FactExtractorService(ai as never).extract('# CV');

    const call = (ai.complete.mock.calls as unknown as [{ systemPrompt: string; outputSchema: unknown }][])[0][0];
    const schema = JSON.stringify(call.outputSchema);
    for (const field of ['section', 'org', 'period']) {
      expect(schema).not.toContain(field);
      expect(call.systemPrompt).not.toContain(field);
    }
  });

  it('leaves context null for a fact the model rephrased away from any source line', async () => {
    // A fact that maps to no heading block has no provable home. Attaching the nearest
    // heading would print an employer the CV never connected the claim to.
    const ai = aiReturning({
      facts: [{ kind: 'achievement', text: 'Won an unrelated award', payload: {}, metric: null }],
    });
    const markdown = '## Experience\n\n### Senior Developer — Acme Corp (2019)\n\n- Cut churn 23%';

    const [fact] = await new FactExtractorService(ai as never).extract(markdown);

    expect(fact.section).toBeNull();
    expect(fact.org).toBeNull();
    expect(fact.period).toBeNull();
  });

  it('returns null context for heading-less markdown rather than inventing structure', async () => {
    // gdocs and document imports pass user-authored markdown through with no structural
    // guarantee at all; that is an expected input, not a failure.
    const ai = aiReturning({
      facts: [{ kind: 'achievement', text: 'Cut churn 23%', payload: {}, metric: null }],
    });

    const [fact] = await new FactExtractorService(ai as never).extract('Cut churn 23%\nLed the migration');

    expect(fact.section).toBeNull();
    expect(fact.org).toBeNull();
    expect(fact.period).toBeNull();
  });

  it('raises rather than returning facts when the markdown is empty', async () => {
    const ai = aiReturning({ facts: [] });

    await expect(new FactExtractorService(ai as never).extract('   ')).rejects.toThrow(/empty/i);
    expect(ai.complete).not.toHaveBeenCalled();
  });
});
