import { ScreeningService } from './screening.service';
import { SCREENING_PROMPT_VERSION, SCREENING_SYSTEM_PROMPT } from './screening.prompt';

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
  { factId: 'f3', text: 'Cut checkout latency to 220ms', kind: 'achievement' },
];

const input = {
  facts,
  questions: ['Why us?', 'Describe your PostgreSQL experience.', 'Do you hold a security clearance?'],
  jobTitle: 'Backend Engineer',
  company: 'Globex',
  language: 'en',
  styleExemplars: [],
};

describe('ScreeningService', () => {
  it('answers each question with grounded paragraphs', async () => {
    const ai = aiReturning({
      answers: [
        { question: 'Why us?', paragraphs: [{ text: 'I cut latency to 220ms.', sourceFactId: 'f3' }] },
        {
          question: 'Describe your PostgreSQL experience.',
          paragraphs: [{ text: 'I ran PostgreSQL in production.', sourceFactId: 'f2' }],
        },
        { question: 'Do you hold a security clearance?', paragraphs: [] },
      ],
    });

    const result = await new ScreeningService(ai as never).generate(input);

    expect(result.answers).toHaveLength(3);
    expect(result.answers[0].paragraphs[0].sourceFactId).toBe('f3');
    expect(result.modelUsed).toBe(SMART_MODEL);
    expect(result.promptVersion).toBe(SCREENING_PROMPT_VERSION);
  });

  it('returns an unanswerable question PRESENT but empty, never omitted', async () => {
    // Silently dropping it would leave the user to discover the gap on the employer's own
    // form. An unanswered question is real signal; an absent one is a surprise.
    const ai = aiReturning({
      answers: [{ question: 'Why us?', paragraphs: [{ text: 'I cut latency.', sourceFactId: 'f3' }] }],
    });

    const result = await new ScreeningService(ai as never).generate(input);

    expect(result.answers).toHaveLength(3);
    const clearance = result.answers.find((a) => a.question.startsWith('Do you hold'));
    expect(clearance).toBeDefined();
    expect(clearance?.paragraphs).toEqual([]);
  });

  it('returns every question in the order they were asked', async () => {
    const ai = aiReturning({ answers: [] });
    const result = await new ScreeningService(ai as never).generate(input);
    expect(result.answers.map((a) => a.question)).toEqual(input.questions);
  });

  it('drops an answer to a question that was never asked', async () => {
    // The model does not get to invent a question: an answer to one nobody posed would be
    // shown to the user as though the employer had asked it.
    const ai = aiReturning({
      answers: [
        { question: 'What are your salary expectations?', paragraphs: [{ text: 'A lot.', sourceFactId: 'f1' }] },
      ],
    });

    const result = await new ScreeningService(ai as never).generate(input);

    expect(result.answers.map((a) => a.question)).toEqual(input.questions);
    expect(result.answers.every((a) => a.paragraphs.length === 0)).toBe(true);
    expect(result.droppedParagraphs.some((d) => d.reason.includes('not asked'))).toBe(true);
  });

  it('allows two DIFFERENT questions to draw on the same fact', async () => {
    // Uniqueness is scoped per question, not across the response: one achievement can honestly
    // answer both "why us" and "describe your experience".
    const ai = aiReturning({
      answers: [
        { question: 'Why us?', paragraphs: [{ text: 'I ran PostgreSQL.', sourceFactId: 'f2' }] },
        {
          question: 'Describe your PostgreSQL experience.',
          paragraphs: [{ text: 'Six years of PostgreSQL in production.', sourceFactId: 'f2' }],
        },
      ],
    });

    const result = await new ScreeningService(ai as never).generate(input);

    expect(result.answers[0].paragraphs).toHaveLength(1);
    expect(result.answers[1].paragraphs).toHaveLength(1);
    expect(result.droppedParagraphs).toHaveLength(0);
  });

  it('drops the same fact used twice WITHIN one question', async () => {
    const ai = aiReturning({
      answers: [
        {
          question: 'Why us?',
          paragraphs: [
            { text: 'I ran PostgreSQL.', sourceFactId: 'f2' },
            { text: 'PostgreSQL is a strength.', sourceFactId: 'f2' },
          ],
        },
      ],
    });

    const result = await new ScreeningService(ai as never).generate(input);

    expect(result.answers[0].paragraphs).toHaveLength(1);
    expect(result.answers[0].droppedParagraphs[0].reason).toContain('already used');
  });

  it('drops a paragraph citing a fact absent from the snapshot', async () => {
    const ai = aiReturning({
      answers: [{ question: 'Why us?', paragraphs: [{ text: 'I led forty people.', sourceFactId: 'f99' }] }],
    });

    const result = await new ScreeningService(ai as never).generate(input);

    expect(result.answers[0].paragraphs).toHaveLength(0);
    expect(result.answers[0].droppedParagraphs[0].reason).toContain('f99');
  });

  it('matches an echoed question that differs only in whitespace and case', async () => {
    // The model reformats. Matching strictly would silently blank every answer.
    const ai = aiReturning({
      answers: [{ question: 'why   us', paragraphs: [{ text: 'I cut latency.', sourceFactId: 'f3' }] }],
    });

    const result = await new ScreeningService(ai as never).generate(input);
    expect(result.answers[0].paragraphs).toHaveLength(1);
  });

  it('rejects a degraded completion and names the model', async () => {
    const ai = aiReturning({ answers: [] }, true);
    await expect(new ScreeningService(ai as never).generate(input)).rejects.toThrow(SMART_MODEL);
  });

  it('never calls the model when there are no facts', async () => {
    const ai = aiReturning({ answers: [] });
    const result = await new ScreeningService(ai as never).generate({ ...input, facts: [] });

    expect(ai.complete).not.toHaveBeenCalled();
    // Every question still comes back, unanswered rather than absent.
    expect(result.answers).toHaveLength(3);
    expect(result.answers.every((a) => a.paragraphs.length === 0)).toBe(true);
  });

  it('never calls the model when there are no questions', async () => {
    const ai = aiReturning({ answers: [] });
    const result = await new ScreeningService(ai as never).generate({ ...input, questions: [] });

    expect(ai.complete).not.toHaveBeenCalled();
    expect(result.answers).toEqual([]);
  });

  it('makes ONE model call for all questions, not one per question', async () => {
    // N calls would N-fold the cost and the timeout exposure for no grounding benefit: the
    // questions share one fact set.
    const ai = aiReturning({ answers: [] });
    await new ScreeningService(ai as never).generate(input);
    expect(ai.complete).toHaveBeenCalledTimes(1);
  });

  it('requests the smart tier', async () => {
    const ai = aiReturning({ answers: [] });
    await new ScreeningService(ai as never).generate(input);
    expect(ai.complete.mock.calls[0][0].tier).toBe('smart');
  });

  it('parses a fenced ```json completion', async () => {
    const ai = aiReturning(
      '```json\n{"answers":[{"question":"Why us?","paragraphs":[{"text":"I cut latency.","sourceFactId":"f3"}]}]}\n```',
    );
    const result = await new ScreeningService(ai as never).generate(input);
    expect(result.answers[0].paragraphs).toHaveLength(1);
  });

  it('raises on an unparseable completion rather than returning empty answers', async () => {
    const ai = aiReturning('not json');
    await expect(new ScreeningService(ai as never).generate(input)).rejects.toThrow(/parse/);
  });
});

describe('SCREENING_SYSTEM_PROMPT', () => {
  it('tells the model that returning no answer is a correct outcome', () => {
    // Without this, a model faced with an unanswerable question invents one — the single most
    // dangerous output in the product, since the user pastes it under their own name.
    expect(SCREENING_SYSTEM_PROMPT).toContain('return NO paragraphs');
    expect(SCREENING_SYSTEM_PROMPT).toContain('not a failure');
  });

  it('forbids the model adding a question of its own', () => {
    expect(SCREENING_SYSTEM_PROMPT).toContain('Never add a question of your own');
  });

  it('binds every paragraph to exactly one fact', () => {
    expect(SCREENING_SYSTEM_PROMPT).toContain('exactly ONE');
    expect(SCREENING_SYSTEM_PROMPT).toContain('Never merge two facts');
  });
});
