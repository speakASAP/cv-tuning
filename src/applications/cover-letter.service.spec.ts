import { CoverLetterService } from './cover-letter.service';
import { COVER_LETTER_PROMPT_VERSION } from './cover-letter.prompt';

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
  requirements: [{ text: 'PostgreSQL at scale', kind: 'must' as const }],
  jobTitle: 'Backend Engineer',
  company: 'Globex',
  language: 'en',
  styleExemplars: [],
  tone: 'plain' as const,
};

describe('CoverLetterService', () => {
  it('returns one paragraph per grounded fact', async () => {
    const ai = aiReturning({
      paragraphs: [
        { text: 'I ran PostgreSQL in production.', sourceFactId: 'f2', targetRequirement: 'PostgreSQL at scale' },
        { text: 'I cut checkout latency to 220ms.', sourceFactId: 'f3', targetRequirement: null },
        { text: 'I was a Senior Developer at Acme.', sourceFactId: 'f1', targetRequirement: null },
      ],
    });

    const result = await new CoverLetterService(ai as never).generate(input);

    expect(result.paragraphs).toHaveLength(3);
    expect(result.droppedParagraphs).toHaveLength(0);
    expect(result.paragraphs[0].sourceFactId).toBe('f2');
    expect(result.paragraphs[0].targetRequirement).toBe('PostgreSQL at scale');
    expect(result.modelUsed).toBe(SMART_MODEL);
    expect(result.promptVersion).toBe(COVER_LETTER_PROMPT_VERSION);
  });

  it('drops a paragraph citing a fact absent from the snapshot, with a reason', async () => {
    // A paragraph whose source fact does not exist cannot be validated by anything downstream,
    // so it must never reach the user.
    const ai = aiReturning({
      paragraphs: [
        { text: 'I led a team of forty.', sourceFactId: 'f99', targetRequirement: null },
        { text: 'I ran PostgreSQL.', sourceFactId: 'f2', targetRequirement: null },
      ],
    });

    const result = await new CoverLetterService(ai as never).generate(input);

    expect(result.paragraphs).toHaveLength(1);
    expect(result.paragraphs[0].sourceFactId).toBe('f2');
    expect(result.droppedParagraphs).toHaveLength(1);
    expect(result.droppedParagraphs[0].text).toBe('I led a team of forty.');
    expect(result.droppedParagraphs[0].reason).toContain('f99');
  });

  it('drops the second paragraph citing an already-used fact', async () => {
    // Splitting one fact across two paragraphs manufactures two claims from evidence that
    // supports one — fabrication by division.
    const ai = aiReturning({
      paragraphs: [
        { text: 'I ran PostgreSQL in production.', sourceFactId: 'f2', targetRequirement: null },
        { text: 'PostgreSQL is something I know well.', sourceFactId: 'f2', targetRequirement: null },
      ],
    });

    const result = await new CoverLetterService(ai as never).generate(input);

    expect(result.paragraphs).toHaveLength(1);
    expect(result.droppedParagraphs).toHaveLength(1);
    expect(result.droppedParagraphs[0].reason).toContain('already used');
  });

  it('drops a paragraph with no text and one citing no fact at all', async () => {
    const ai = aiReturning({
      paragraphs: [
        { text: '   ', sourceFactId: 'f2', targetRequirement: null },
        { text: 'A claim from nowhere.', sourceFactId: '', targetRequirement: null },
      ],
    });

    const result = await new CoverLetterService(ai as never).generate(input);

    expect(result.paragraphs).toHaveLength(0);
    expect(result.droppedParagraphs).toHaveLength(2);
  });

  it('rejects a degraded completion and names the model in the message', async () => {
    // A letter written by a downgraded model is the auto-rejected output this product exists
    // to prevent.
    const ai = aiReturning({ paragraphs: [] }, true);

    await expect(new CoverLetterService(ai as never).generate(input)).rejects.toThrow(SMART_MODEL);
  });

  it('never calls the model when there are no facts', async () => {
    // Calling it here could only produce invention: there is no material to ground anything in.
    const ai = aiReturning({ paragraphs: [] });

    const result = await new CoverLetterService(ai as never).generate({ ...input, facts: [] });

    expect(ai.complete).not.toHaveBeenCalled();
    expect(result.paragraphs).toHaveLength(0);
    expect(result.promptVersion).toBe(COVER_LETTER_PROMPT_VERSION);
  });

  it('parses a fenced ```json completion', async () => {
    const ai = aiReturning(
      '```json\n{"paragraphs":[{"text":"I ran PostgreSQL.","sourceFactId":"f2","targetRequirement":null}]}\n```',
    );

    const result = await new CoverLetterService(ai as never).generate(input);
    expect(result.paragraphs).toHaveLength(1);
  });

  it('raises on an unparseable completion rather than returning no paragraphs', async () => {
    // "The model returned garbage" and "the model found nothing to say" are different
    // outcomes and must stay distinguishable to the caller.
    const ai = aiReturning('not json at all');
    await expect(new CoverLetterService(ai as never).generate(input)).rejects.toThrow(/parse/);
  });

  it('raises when the completion has no paragraphs array', async () => {
    const ai = aiReturning({ bullets: [] });
    await expect(new CoverLetterService(ai as never).generate(input)).rejects.toThrow(/paragraphs/);
  });

  it('requests the smart tier', async () => {
    const ai = aiReturning({ paragraphs: [] });
    await new CoverLetterService(ai as never).generate(input);
    expect(ai.complete.mock.calls[0][0].tier).toBe('smart');
  });
});
