import { ConflictException, NotFoundException } from '@nestjs/common';
import { SupplementsService } from './supplements.service';

const MODEL = 'openrouter/google/gemma-4-31b-it:free';
const VALIDATOR = 'openrouter/validator';

const FACTS = [
  { factId: 'f1', text: 'Ran PostgreSQL in production', kind: 'achievement', section: 'Experience', title: null, org: 'Acme', period: '2019-2024' },
  { factId: 'f2', text: 'Cut checkout latency to 220ms', kind: 'achievement', section: 'Experience', title: null, org: 'Acme', period: '2019-2024' },
];

const PINNED_MASTER = '# Jane Doe\n\njane@example.com\n\n## Experience\n\n- Ran PostgreSQL\n';

const application = {
  id: 'app-1',
  userId: 'u1',
  jobId: 'job-1',
  masterVersionId: 'master-pinned',
  renderLanguage: 'en',
  state: 'in_review',
};

const build = (overrides: Record<string, unknown> = {}) => {
  const saved: Record<string, unknown>[] = [];

  const supplements = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.idempotencyKey) {
        return saved.find((s) => s.idempotencyKey === where.idempotencyKey) ?? null;
      }
      const matching = saved
        .filter((s) => s.applicationId === where.applicationId && s.kind === where.kind)
        .sort((a, b) => (b.revisionNo as number) - (a.revisionNo as number));
      return matching[0] ?? null;
    }),
    find: jest.fn(async () => saved),
    save: jest.fn(async (row: Record<string, unknown>) => {
      const stored = { ...row, id: `sup-${saved.length + 1}` };
      saved.push(stored);
      return stored;
    }),
  };

  const applications = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === application.id && where.userId === application.userId ? application : null,
    ),
    update: jest.fn(async () => undefined),
  };

  const master = {
    getVersion: jest.fn(async (_userId: string, masterId: string) =>
      masterId === 'master-pinned'
        ? { master: { id: 'master-pinned', markdown: PINNED_MASTER }, facts: FACTS }
        : { master: { id: masterId, markdown: '# Someone Else\n\n## Experience\n' }, facts: [] },
    ),
  };

  const jobs = {
    get: jest.fn(async () => ({
      job: {
        id: 'job-1',
        title: 'Backend Engineer',
        company: 'Globex',
        screeningQuestions: ['Why us?'],
        parsed: { requirements: [{ text: 'PostgreSQL', kind: 'must' }], screeningQuestions: ['Why us?'] },
      },
    })),
  };

  const coverLetter = {
    generate: jest.fn(async () => ({
      paragraphs: [
        { text: 'I ran PostgreSQL in production.', sourceFactId: 'f1', targetRequirement: 'PostgreSQL' },
        { text: 'I cut checkout latency to 220ms.', sourceFactId: 'f2', targetRequirement: null },
      ],
      droppedParagraphs: [],
      modelUsed: MODEL,
      promptVersion: 'cover-letter-v1',
    })),
  };

  const screening = {
    generate: jest.fn(async () => ({
      answers: [
        {
          question: 'Why us?',
          paragraphs: [{ text: 'I cut latency to 220ms.', sourceFactId: 'f2', targetRequirement: null }],
          droppedParagraphs: [],
        },
      ],
      droppedParagraphs: [],
      modelUsed: MODEL,
      promptVersion: 'screening-v1',
    })),
  };

  const entail = {
    validate: jest.fn(async (paragraphs: { text: string; sourceFactId: string }[]) => ({
      bullets: paragraphs.map((p) => ({ ...p, bulletId: `b:${p.sourceFactId}`, verdict: 'supported', span: null })),
      validatorModelUsed: VALIDATOR,
      validatorPromptVersion: 'entail-v1',
    })),
  };

  const deps = { supplements, applications, master, jobs, coverLetter, screening, entail, ...overrides };

  return {
    ...deps,
    saved,
    service: new SupplementsService(
      deps.supplements as never,
      deps.applications as never,
      deps.master as never,
      deps.jobs as never,
      deps.coverLetter as never,
      deps.screening as never,
      deps.entail as never,
    ),
  };
};

describe('SupplementsService.generateCoverLetter', () => {
  it('produces a letter grounded in the pinned facts', async () => {
    const { service, saved } = build();

    const result = await service.generateCoverLetter('u1', 'app-1', { tone: 'plain' });

    expect(result.content).toContain('Dear Globex Hiring Team,');
    expect(result.content).toContain('I ran PostgreSQL in production.');
    expect(result.content).toContain('Jane Doe');
    expect(saved).toHaveLength(1);
    expect(saved[0].kind).toBe('cover_letter');
    expect(saved[0].revisionNo).toBe(1);
  });

  it('records both models and both prompt versions', async () => {
    const { service, saved } = build();
    await service.generateCoverLetter('u1', 'app-1', {});

    expect(saved[0].modelUsed).toBe(MODEL);
    expect(saved[0].validatorModelUsed).toBe(VALIDATOR);
    expect(saved[0].promptVersion).toBe('cover-letter-v1');
    expect(saved[0].validatorPromptVersion).toBe('entail-v1');
  });

  it('snapshots the facts it used', async () => {
    const { service, saved } = build();
    await service.generateCoverLetter('u1', 'app-1', {});
    expect(saved[0].factsSnapshot).toEqual(FACTS);
  });

  it('scores the AI tell of the assembled letter', async () => {
    const { service, saved } = build();
    await service.generateCoverLetter('u1', 'app-1', {});
    expect(typeof saved[0].aiTellScore).toBe('number');
  });

  it('drops an overreach paragraph and records the verdict and span', async () => {
    const entail = {
      validate: jest.fn(async (paragraphs: { text: string; sourceFactId: string }[]) => ({
        bullets: paragraphs.map((p, i) => ({
          ...p,
          bulletId: `b:${p.sourceFactId}`,
          verdict: i === 0 ? 'overreach' : 'supported',
          span: i === 0 ? 'in production' : null,
        })),
        validatorModelUsed: VALIDATOR,
        validatorPromptVersion: 'entail-v1',
      })),
    };
    const { service, saved } = build({ entail });

    const result = await service.generateCoverLetter('u1', 'app-1', {});

    expect(result.content).not.toContain('I ran PostgreSQL in production.');
    expect(result.content).toContain('I cut checkout latency to 220ms.');

    const provenance = saved[0].provenance as { droppedParagraphs: { reason: string }[] };
    expect(provenance.droppedParagraphs).toHaveLength(1);
    expect(provenance.droppedParagraphs[0].reason).toContain('overreach');
    expect(provenance.droppedParagraphs[0].reason).toContain('in production');
  });

  it('raises when a non-supported verdict carries no span', async () => {
    // A downgrade with no span leaves the UI nothing to show the user. EntailService
    // synthesizes one, so a null here means the invariant broke upstream.
    const entail = {
      validate: jest.fn(async (paragraphs: { sourceFactId: string }[]) => ({
        bullets: paragraphs.map((p) => ({ ...p, verdict: 'overreach', span: null })),
        validatorModelUsed: VALIDATOR,
        validatorPromptVersion: 'entail-v1',
      })),
    };
    const { service } = build({ entail });

    await expect(service.generateCoverLetter('u1', 'app-1', {})).rejects.toThrow(/span/);
  });

  it('returns the existing row for a repeated request instead of generating again', async () => {
    const { service, coverLetter } = build();

    const first = await service.generateCoverLetter('u1', 'app-1', { tone: 'plain' });
    const second = await service.generateCoverLetter('u1', 'app-1', { tone: 'plain' });

    expect(second.id).toBe(first.id);
    expect(coverLetter.generate).toHaveBeenCalledTimes(1);
  });

  it('generates a NEW revision when the request body differs', async () => {
    const { service, coverLetter } = build();

    await service.generateCoverLetter('u1', 'app-1', { tone: 'plain' });
    const second = await service.generateCoverLetter('u1', 'app-1', { tone: 'warm' });

    expect(second.revisionNo).toBe(2);
    expect(coverLetter.generate).toHaveBeenCalledTimes(2);
  });

  it('404s on another user application', async () => {
    const { service } = build();
    await expect(service.generateCoverLetter('someone-else', 'app-1', {})).rejects.toThrow(
      NotFoundException,
    );
  });

  it('generates against the PINNED master, never the current one', async () => {
    // spec 4.2 immutability: a supplement is generated against the same facts the CV was.
    const { service, master } = build();
    await service.generateCoverLetter('u1', 'app-1', {});
    expect(master.getVersion).toHaveBeenCalledWith('u1', 'master-pinned');
  });

  it('raises rather than proceeding when the pinned master is gone', async () => {
    const master = { getVersion: jest.fn(async () => null) };
    const { service } = build({ master });
    await expect(service.generateCoverLetter('u1', 'app-1', {})).rejects.toThrow(/master-pinned/);
  });

  it('does NOT touch the application state machine', async () => {
    // A supplement is an accompanying artefact, not a step in the CV state machine.
    const { service, applications } = build();
    await service.generateCoverLetter('u1', 'app-1', {});
    expect(applications.update).not.toHaveBeenCalled();
  });

  it('raises when the job has no parsed requirements', async () => {
    const jobs = { get: jest.fn(async () => ({ job: { id: 'job-1', title: null, company: null, parsed: null } })) };
    const { service } = build({ jobs });
    await expect(service.generateCoverLetter('u1', 'app-1', {})).rejects.toThrow(ConflictException);
  });
});

describe('SupplementsService.generateScreening', () => {
  it('answers the merged question list', async () => {
    const { service, saved } = build();

    const result = await service.generateScreening('u1', 'app-1', { questions: ['Notice period?'] });

    // The user question leads, then the parsed one.
    expect(result.content).toContain('Notice period?');
    expect(result.content).toContain('Why us?');
    expect(saved[0].kind).toBe('screening');
  });

  it('shows an unanswerable question as unanswered rather than omitting it', async () => {
    const screening = {
      generate: jest.fn(async () => ({
        answers: [
          { question: 'Why us?', paragraphs: [], droppedParagraphs: [] },
          {
            question: 'Notice period?',
            paragraphs: [{ text: 'I cut latency.', sourceFactId: 'f2', targetRequirement: null }],
            droppedParagraphs: [],
          },
        ],
        droppedParagraphs: [],
        modelUsed: MODEL,
        promptVersion: 'screening-v1',
      })),
    };
    const { service } = build({ screening });

    const result = await service.generateScreening('u1', 'app-1', { questions: ['Notice period?'] });

    expect(result.content).toContain('Why us?');
    expect(result.content).toMatch(/no (grounded )?answer/i);
  });

  it('validates every question paragraphs in ONE entailment call', async () => {
    const screening = {
      generate: jest.fn(async () => ({
        answers: [
          { question: 'Why us?', paragraphs: [{ text: 'A.', sourceFactId: 'f1', targetRequirement: null }], droppedParagraphs: [] },
          { question: 'Notice period?', paragraphs: [{ text: 'B.', sourceFactId: 'f2', targetRequirement: null }], droppedParagraphs: [] },
        ],
        droppedParagraphs: [],
        modelUsed: MODEL,
        promptVersion: 'screening-v1',
      })),
    };
    const { service, entail } = build({ screening });

    await service.generateScreening('u1', 'app-1', { questions: ['Notice period?'] });

    expect(entail.validate).toHaveBeenCalledTimes(1);
    expect(entail.validate.mock.calls[0][0]).toHaveLength(2);
  });

  it('re-attaches verdicts to the right question when two questions cite one fact', async () => {
    // By INDEX, not by sourceFactId: EntailService returns verdicts in input order, and a fact
    // shared between two questions makes sourceFactId ambiguous as a key.
    const screening = {
      generate: jest.fn(async () => ({
        answers: [
          { question: 'Why us?', paragraphs: [{ text: 'Good one.', sourceFactId: 'f2', targetRequirement: null }], droppedParagraphs: [] },
          { question: 'Notice period?', paragraphs: [{ text: 'Bad one.', sourceFactId: 'f2', targetRequirement: null }], droppedParagraphs: [] },
        ],
        droppedParagraphs: [],
        modelUsed: MODEL,
        promptVersion: 'screening-v1',
      })),
    };
    const entail = {
      validate: jest.fn(async (paragraphs: { text: string; sourceFactId: string }[]) => ({
        bullets: paragraphs.map((p) => ({
          ...p,
          verdict: p.text === 'Bad one.' ? 'unsupported' : 'supported',
          span: p.text === 'Bad one.' ? 'Bad one.' : null,
        })),
        validatorModelUsed: VALIDATOR,
        validatorPromptVersion: 'entail-v1',
      })),
    };
    const { service } = build({ screening, entail });

    const result = await service.generateScreening('u1', 'app-1', { questions: ['Notice period?'] });
    const provenance = result.provenance as unknown as {
      answers: { question: string; paragraphs: { text: string }[]; droppedParagraphs: { text: string }[] }[];
    };

    // The kept paragraph must land under ITS OWN question, and the dropped one under its own.
    // Asserting only on the rendered text would pass even if the two were swapped.
    const whyUs = provenance.answers.find((a) => a.question === 'Why us?');
    const notice = provenance.answers.find((a) => a.question === 'Notice period?');

    expect(whyUs?.paragraphs.map((p) => p.text)).toEqual(['Good one.']);
    expect(whyUs?.droppedParagraphs).toHaveLength(0);
    expect(notice?.paragraphs).toHaveLength(0);
    expect(notice?.droppedParagraphs.map((p) => p.text)).toEqual(['Bad one.']);

    expect(result.content).toContain('Good one.');
    expect(result.content).not.toContain('Bad one.');
  });

  it('404s on another user application', async () => {
    const { service } = build();
    await expect(service.generateScreening('nope', 'app-1', {})).rejects.toThrow(NotFoundException);
  });
});

describe('SupplementsService.list and get', () => {
  it('lists supplements for an owned application', async () => {
    const { service } = build();
    await service.generateCoverLetter('u1', 'app-1', {});
    expect(await service.list('u1', 'app-1')).toHaveLength(1);
  });

  it('404s listing another user application', async () => {
    const { service } = build();
    await expect(service.list('nope', 'app-1')).rejects.toThrow(NotFoundException);
  });

  it('404s getting a revision that does not exist', async () => {
    const { service } = build();
    await expect(service.get('u1', 'app-1', 'cover_letter', 7)).rejects.toThrow(NotFoundException);
  });
});
