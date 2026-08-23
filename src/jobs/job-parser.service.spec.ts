import { JobParserService } from './job-parser.service';

const CHEAP_MODEL = 'openrouter/google/gemma-4-26b-a4b-it:free';

const aiReturning = (payload: unknown, degraded = false) => ({
  complete: jest.fn(async () => ({
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    modelUsed: CHEAP_MODEL,
    degraded,
  })),
});

const POSTING = 'We need a senior engineer. Must have TypeScript. Nice to have Kubernetes.';

describe('JobParserService', () => {
  it('extracts requirements with must/nice classification', async () => {
    const ai = aiReturning({
      title: 'Senior Engineer',
      company: 'Acme',
      language: 'en',
      requirements: [
        { text: 'TypeScript', kind: 'must', category: 'language' },
        { text: 'Kubernetes', kind: 'nice', category: 'infrastructure' },
      ],
    });

    const parsed = await new JobParserService(ai as never).parse(POSTING);

    expect(parsed.title).toBe('Senior Engineer');
    expect(parsed.requirements).toHaveLength(2);
    expect(parsed.requirements[0].kind).toBe('must');
    expect(parsed.requirements[1].kind).toBe('nice');
  });

  it('uses the cheap tier', async () => {
    const ai = aiReturning({ title: null, company: null, language: 'en', requirements: [] });

    await new JobParserService(ai as never).parse(POSTING);

    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ tier: 'cheap' }));
  });

  it('detects the posting language', async () => {
    const ai = aiReturning({ title: null, company: null, language: 'cs', requirements: [] });

    expect((await new JobParserService(ai as never).parse(POSTING)).language).toBe('cs');
  });

  it('defaults the language to en when the model omits it', async () => {
    const ai = aiReturning({ title: null, company: null, requirements: [] });

    expect((await new JobParserService(ai as never).parse(POSTING)).language).toBe('en');
  });

  it('raises on unparseable model output rather than returning no requirements', async () => {
    const ai = aiReturning('not json');

    await expect(new JobParserService(ai as never).parse(POSTING)).rejects.toThrow(/parse/i);
  });

  it('raises when the payload has no requirements array', async () => {
    const ai = aiReturning({ title: 'x' });

    await expect(new JobParserService(ai as never).parse(POSTING)).rejects.toThrow(/requirements/);
  });

  it('rejects a requirement with an unrecognised kind', async () => {
    const ai = aiReturning({
      language: 'en',
      requirements: [{ text: 'TypeScript', kind: 'essential', category: 'language' }],
    });

    await expect(new JobParserService(ai as never).parse(POSTING)).rejects.toThrow(/kind/);
  });

  it('rejects a requirement with no text', async () => {
    const ai = aiReturning({ language: 'en', requirements: [{ text: '  ', kind: 'must', category: 'x' }] });

    await expect(new JobParserService(ai as never).parse(POSTING)).rejects.toThrow(/text/i);
  });

  it('tolerates a fenced JSON code block', async () => {
    const ai = aiReturning(
      '```json\n{"language":"en","requirements":[{"text":"Go","kind":"must","category":"language"}]}\n```',
    );

    expect((await new JobParserService(ai as never).parse(POSTING)).requirements[0].text).toBe('Go');
  });

  it('raises when parsing ran on a degraded model', async () => {
    const ai = aiReturning({ language: 'en', requirements: [] }, true);

    await expect(new JobParserService(ai as never).parse(POSTING)).rejects.toThrow(/degraded/i);
  });

  it('raises rather than parsing empty text', async () => {
    const ai = aiReturning({ language: 'en', requirements: [] });

    await expect(new JobParserService(ai as never).parse('   ')).rejects.toThrow(/empty/i);
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('returns an empty requirements list for a posting that states none', async () => {
    const ai = aiReturning({ title: 'Vague Role', company: null, language: 'en', requirements: [] });

    await expect(new JobParserService(ai as never).parse(POSTING)).resolves.toMatchObject({ requirements: [] });
  });
});
