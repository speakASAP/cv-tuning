import { TailorService } from './tailor.service';
import { TAILOR_PROMPT_VERSION } from './tailor.prompt';

const SMART_MODEL = 'openrouter/google/gemma-4-31b-it:free';

const aiReturning = (payload: unknown, degraded = false) => ({
  complete: jest.fn(async (_req: { tier: string; userPrompt: string }) => ({
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    modelUsed: SMART_MODEL,
    degraded,
  })),
});

const facts = [
  { factId: 'f1', text: 'Senior Developer at Acme, 2019-2024', kind: 'role' },
  { factId: 'f2', text: 'Ran PostgreSQL in production', kind: 'achievement' },
];

const requirements = [{ text: 'PostgreSQL at scale', kind: 'must' as const }];

const input = {
  facts,
  requirements,
  jobTitle: 'Backend Engineer',
  company: 'Globex',
  language: 'en',
  styleExemplars: [],
};

describe('TailorService', () => {
  it('rewrites a master bullet toward a requirement', async () => {
    const ai = aiReturning({
      bullets: [{ text: 'Ran PostgreSQL in production for 40M rows', sourceFactId: 'f2', targetRequirement: 'PostgreSQL at scale' }],
    });

    const result = await new TailorService(ai as never).tailor(input);

    expect(result.bullets).toHaveLength(1);
    expect(result.bullets[0].sourceFactId).toBe('f2');
    expect(result.bullets[0].targetRequirement).toBe('PostgreSQL at scale');
  });

  it('records the served model and prompt version', async () => {
    const ai = aiReturning({ bullets: [{ text: 'x', sourceFactId: 'f1' }] });

    const result = await new TailorService(ai as never).tailor(input);

    // Spec §8.0: the tier that was asked for is not evidence of what actually ran.
    expect(result.modelUsed).toBe(SMART_MODEL);
    expect(result.promptVersion).toBe(TAILOR_PROMPT_VERSION);
  });

  it('drops a bullet citing an unknown sourceFactId', async () => {
    const ai = aiReturning({
      bullets: [
        { text: 'Ran PostgreSQL in production', sourceFactId: 'f2' },
        { text: 'Led a team of 12 engineers', sourceFactId: 'f-invented' },
      ],
    });

    const result = await new TailorService(ai as never).tailor(input);

    // A bullet whose source does not exist is unfalsifiable: nothing can validate it.
    expect(result.bullets).toHaveLength(1);
    expect(result.droppedBullets).toHaveLength(1);
    expect(result.droppedBullets[0].text).toBe('Led a team of 12 engineers');
  });

  it('drops a bullet citing no source at all', async () => {
    const ai = aiReturning({
      bullets: [{ text: 'Passionate about distributed systems', sourceFactId: '' }],
    });

    const result = await new TailorService(ai as never).tailor(input);

    expect(result.bullets).toHaveLength(0);
    expect(result.droppedBullets).toHaveLength(1);
  });

  it('records why each bullet was dropped rather than silently omitting it', async () => {
    const ai = aiReturning({ bullets: [{ text: 'Invented', sourceFactId: 'nope' }] });

    const result = await new TailorService(ai as never).tailor(input);

    expect(result.droppedBullets[0].reason).toMatch(/unknown|source/i);
  });

  it('emits a bullet that overstates its source, leaving the judgement to the validator', async () => {
    const ai = aiReturning({
      bullets: [{ text: 'Led a team of 12 as Senior Developer at Acme', sourceFactId: 'f1' }],
    });

    const result = await new TailorService(ai as never).tailor(input);

    // Generation enforces provenance, not truth. Entailment is a separate call by design:
    // a model must never be the sole judge of its own output.
    expect(result.bullets).toHaveLength(1);
  });

  it('raises when generation ran on a degraded model', async () => {
    const ai = aiReturning({ bullets: [] }, true);

    await expect(new TailorService(ai as never).tailor(input)).rejects.toThrow(/degraded/i);
  });

  it('raises rather than returning nothing when the response is malformed', async () => {
    const ai = aiReturning('not json at all');

    await expect(new TailorService(ai as never).tailor(input)).rejects.toThrow(/parse/i);
  });

  it('raises when the response has no bullets array', async () => {
    const ai = aiReturning({ something: 'else' });

    await expect(new TailorService(ai as never).tailor(input)).rejects.toThrow(/bullets/i);
  });

  it('returns no bullets without calling the model when the CV has no facts', async () => {
    const ai = aiReturning({ bullets: [] });

    const result = await new TailorService(ai as never).tailor({ ...input, facts: [] });

    expect(result.bullets).toEqual([]);
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('never emits more bullets than there are master facts', async () => {
    const ai = aiReturning({
      bullets: [
        { text: 'a', sourceFactId: 'f1' },
        { text: 'b', sourceFactId: 'f1' },
        { text: 'c', sourceFactId: 'f2' },
        { text: 'd', sourceFactId: 'f2' },
      ],
    });

    const result = await new TailorService(ai as never).tailor(input);

    // One bullet per fact. Two bullets from one fact means the fact was split into claims
    // it does not individually support.
    expect(result.bullets.length).toBeLessThanOrEqual(facts.length);
  });

  it('passes the fact ids into the prompt so the model can cite them', async () => {
    const ai = aiReturning({ bullets: [] });

    await new TailorService(ai as never).tailor(input);

    const prompt = ai.complete.mock.calls[0][0];
    expect(prompt.userPrompt).toContain('f1');
    expect(prompt.userPrompt).toContain('f2');
    expect(prompt.tier).toBe('smart');
  });
});
