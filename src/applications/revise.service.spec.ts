import { ReviseService } from './revise.service';
import { RevisePromptInput } from './revise.prompt';

const facts = [
  { factId: 'f1', text: 'Senior Developer at Acme', kind: 'role' },
  { factId: 'f2', text: 'Ran PostgreSQL in production', kind: 'achievement' },
];

const input: RevisePromptInput = {
  facts,
  requirements: [{ text: 'PostgreSQL', kind: 'must' }],
  jobTitle: 'Engineer',
  company: 'Globex',
  language: 'en',
  styleExemplars: [],
  previousMarkdown: '- Senior Developer at Acme',
  history: [],
  instruction: 'make it punchier',
};

const aiReturning = (text: string, degraded = false) =>
  ({ complete: jest.fn().mockResolvedValue({ text, modelUsed: 'm', degraded }) }) as never;

describe('ReviseService', () => {
  it('returns bullets bound to real facts', async () => {
    const service = new ReviseService(
      aiReturning(JSON.stringify({ bullets: [{ text: 'Ran PostgreSQL', sourceFactId: 'f2' }] })),
    );
    const result = await service.revise(input);
    expect(result.bullets).toHaveLength(1);
    expect(result.bullets[0].sourceFactId).toBe('f2');
  });

  it('drops a bullet citing a fact that is not in the snapshot, with a reason', async () => {
    const service = new ReviseService(
      aiReturning(JSON.stringify({ bullets: [{ text: 'Led a team of 12', sourceFactId: 'ghost' }] })),
    );
    const result = await service.revise(input);
    expect(result.bullets).toHaveLength(0);
    expect(result.droppedBullets[0].reason).toContain('ghost');
  });

  it('raises when the model returns unparseable JSON, never an empty revision', async () => {
    const service = new ReviseService(aiReturning('not json at all'));
    await expect(service.revise(input)).rejects.toThrow(/parse/i);
  });

  it('raises when the tier was served by an unexpected model', async () => {
    const service = new ReviseService(
      aiReturning(JSON.stringify({ bullets: [{ text: 'x', sourceFactId: 'f1' }] }), true),
    );
    await expect(service.revise(input)).rejects.toThrow(/degraded/i);
  });

  it('never emits more bullets than there are master facts', async () => {
    const service = new ReviseService(
      aiReturning(
        JSON.stringify({
          bullets: [
            { text: 'a', sourceFactId: 'f1' },
            { text: 'b', sourceFactId: 'f1' },
          ],
        }),
      ),
    );
    const result = await service.revise(input);

    // One bullet per fact. Two bullets from one fact means the fact was split into claims
    // it does not individually support.
    expect(result.bullets).toHaveLength(1);
    expect(result.droppedBullets[0].reason).toContain('already used');
  });

  it('drops a bullet with missing text or sourceFactId, with a reason', async () => {
    const service = new ReviseService(
      aiReturning(JSON.stringify({ bullets: [{ text: '', sourceFactId: 'f1' }] })),
    );
    const result = await service.revise(input);

    expect(result.bullets).toHaveLength(0);
    expect(result.droppedBullets[0].reason).toContain('missing text or sourceFactId');
  });
});
