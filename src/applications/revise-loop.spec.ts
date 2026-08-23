import { ConflictException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';

// A minimal harness: only the collaborators `revise` actually touches.
function makeService(overrides: {
  state?: string;
  revisionCount?: number;
  reviseImpl?: jest.Mock;
  /** Turns this user has already spent in the current rate-limit window. */
  recentTurns?: number;
}) {
  const application = {
    id: 'app-1',
    userId: 'u1',
    jobId: 'job-1',
    masterVersionId: 'mv-1',
    state: overrides.state ?? 'in_review',
    revisionCount: overrides.revisionCount ?? 0,
    renderLanguage: 'en',
  };
  const applications = {
    findOne: jest.fn().mockResolvedValue(application),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const renders = {
    findOne: jest.fn().mockResolvedValue({ id: 'r1', revisionNo: 1, markdown: '- old' }),
    find: jest.fn().mockResolvedValue([{ id: 'r1', revisionNo: 1, markdown: '- old' }]),
    save: jest.fn().mockImplementation((r) => Promise.resolve({ ...r, id: 'r2' })),
  };
  // The rate limiter counts through a query builder, so the stub must be chainable.
  const chats = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue({}),
    createQueryBuilder: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(overrides.recentTurns ?? 0),
    }),
  };
  const jobs = {
    get: jest.fn().mockResolvedValue({
      job: { title: 'E', company: 'G', parsed: { requirements: [] } },
    }),
  };
  const master = {
    getVersion: jest.fn().mockResolvedValue({ facts: [{ id: 'f1', payload: {}, kind: 'role' }] }),
  };
  const revise = {
    revise:
      overrides.reviseImpl ??
      jest.fn().mockResolvedValue({
        bullets: [{ text: 'new', sourceFactId: 'f1', targetRequirement: null }],
        droppedBullets: [],
        modelUsed: 'm',
        promptVersion: 'revise-v1',
      }),
  };
  const entail = {
    validate: jest.fn().mockResolvedValue({
      bullets: [{ text: 'new', sourceFactId: 'f1', targetRequirement: null, verdict: 'supported', span: null }],
      validatorModelUsed: 'v',
      validatorPromptVersion: 'entail-v1',
    }),
  };

  // 12 positional args — the full Phase 4 signature from Global Constraints.
  const service = new ApplicationsService(
    applications as never, renders as never, jobs as never,
    master as never, {} as never, entail as never,
    revise as never, chats as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  return { service, applications, renders, chats, revise, entail };
}

describe('ApplicationsService.revise', () => {
  it('re-runs BOTH grounding layers on every turn', async () => {
    const { service, revise, entail } = makeService({});
    await service.revise('u1', 'app-1', 'make it punchier', 'text');
    expect(revise.revise).toHaveBeenCalledTimes(1);
    expect(entail.validate).toHaveBeenCalledTimes(1);
  });

  it('rejects a second concurrent turn instead of racing for the same revision number', async () => {
    const { service } = makeService({ state: 'revising' });
    await expect(service.revise('u1', 'app-1', 'x', 'text')).rejects.toThrow(/already in progress/i);
  });

  it('rejects a revision once the per-application cap is reached', async () => {
    const { service } = makeService({ revisionCount: 20 });
    await expect(service.revise('u1', 'app-1', 'x', 'text')).rejects.toThrow(/cap/i);
  });

  it('rejects a revision from a state that cannot accept one, naming that state', async () => {
    const { service } = makeService({ state: 'approved' });
    await expect(service.revise('u1', 'app-1', 'x', 'text')).rejects.toThrow(/approved/);
  });

  it('rejects a turn once the per-user rate limit is exhausted, distinctly from the cap', async () => {
    // 10 turns already used this hour; the cap is untouched, so only the rate limit can fire.
    const { service } = makeService({ recentTurns: 10 });
    await expect(service.revise('u1', 'app-1', 'one too many', 'text')).rejects.toThrow(/rate limit/i);
  });

  it('allows a turn while under the rate limit', async () => {
    const { service, revise } = makeService({ recentTurns: 9 });
    await service.revise('u1', 'app-1', 'fine', 'text');
    expect(revise.revise).toHaveBeenCalled();
  });

  it('lands in generation_failed with the error when a turn dies mid-flight', async () => {
    const { service, applications } = makeService({
      reviseImpl: jest.fn().mockRejectedValue(new Error('model exploded')),
    });
    await expect(service.revise('u1', 'app-1', 'x', 'text')).rejects.toThrow('model exploded');
    expect(applications.update).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ state: 'generation_failed', stateError: 'model exploded' }),
    );
  });

  it('persists both the user turn and the assistant turn', async () => {
    const { service, chats } = makeService({});
    await service.revise('u1', 'app-1', 'make it punchier', 'voice');
    const roles = chats.save.mock.calls.map((c) => c[0].role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(chats.save.mock.calls[0][0].inputMode).toBe('voice');
  });
});
