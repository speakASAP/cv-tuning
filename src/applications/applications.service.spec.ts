import { ConflictException, NotFoundException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';

const SMART_MODEL = 'openrouter/google/gemma-4-31b-it:free';

const masterV1 = {
  master: { id: 'm1', markdown: '# Jane Doe\n\n- Senior Developer at Acme', version: 1 },
  facts: [{ factId: 'f1', text: 'Senior Developer at Acme', kind: 'role' }],
};
const masterV2 = {
  master: { id: 'm2', markdown: '# Jane Doe\n\n- Principal Engineer at Acme', version: 2 },
  facts: [{ factId: 'f9', text: 'Principal Engineer at Acme', kind: 'role' }],
};

const job = {
  id: 'j1',
  title: 'Backend Engineer',
  company: 'Globex',
  language: 'en',
  fetchStatus: 'ok',
  parsed: { requirements: [{ text: 'PostgreSQL', kind: 'must', category: 'tech' }] },
};

/** Minimal in-memory stand-ins; the point under test is orchestration, not TypeORM. */
const makeRepo = <T extends { id?: string }>() => {
  const rows: T[] = [];
  return {
    rows,
    create: jest.fn((data: T) => ({ ...data })),
    save: jest.fn(async (data: T) => {
      const row = { ...data, id: data.id ?? `row${rows.length + 1}` } as T;
      rows.push(row);
      return row;
    }),
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        rows.find((row) =>
          Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
        ) ?? null
      );
    }),
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((row) =>
        Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
      ),
    ),
    update: jest.fn(async (id: string, patch: Partial<T>) => {
      const row = rows.find((r) => (r as { id?: string }).id === id);
      if (row) Object.assign(row, patch);
      return { affected: row ? 1 : 0 };
    }),
  };
};

const build = (overrides: Record<string, unknown> = {}) => {
  const applications = makeRepo<Record<string, unknown> & { id?: string }>();
  const renders = makeRepo<Record<string, unknown> & { id?: string }>();

  const jobs = { get: jest.fn(async () => ({ job })) };
  const master = {
    getCurrent: jest.fn(async () => masterV1),
    getVersion: jest.fn(async (_u: string, id: string) =>
      id === 'm1' ? masterV1 : id === 'm2' ? masterV2 : null,
    ),
  };
  const tailor = {
    tailor: jest.fn(async (_input: { facts: { factId: string; text: string; kind: string }[] }) => ({
      bullets: [{ text: 'Senior Developer at Acme for five years', sourceFactId: 'f1', targetRequirement: null }],
      droppedBullets: [],
      modelUsed: SMART_MODEL,
      promptVersion: 'tailor-v1',
    })),
  };
  const entail = {
    validate: jest.fn(async (bullets: { text: string; sourceFactId: string }[]) => ({
      bullets: bullets.map((b) => ({ ...b, targetRequirement: null, verdict: 'supported', span: null })),
      validatorModelUsed: SMART_MODEL,
      validatorPromptVersion: 'entail-v1',
    })),
  };

  Object.assign({ jobs, master, tailor, entail }, overrides);

  const service = new ApplicationsService(
    applications as never,
    renders as never,
    (overrides.jobs ?? jobs) as never,
    (overrides.master ?? master) as never,
    (overrides.tailor ?? tailor) as never,
    (overrides.entail ?? entail) as never,
    // Phase 4 collaborators: not exercised by these (pre-Phase-4) orchestration tests.
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // Phase 5: not exercised here, but a real double so an unexpected call fails loudly.
    { startOutcomeWatch: jest.fn(), deliverSignal: jest.fn() } as never,
  );

  return { service, applications, renders, jobs, master, tailor, entail };
};

describe('ApplicationsService', () => {
  it('creates an application and pins the master version that was current', async () => {
    const { service, applications } = build();

    await service.create('u1', 'j1');

    expect(applications.rows[0].masterVersionId).toBe('m1');
  });

  it('generates revision 1 with full model attribution', async () => {
    const { service, renders } = build();

    const view = await service.create('u1', 'j1');

    // Spec §8.0: the served model, the validator's model, and the tier are all recorded.
    expect(view.render.modelUsed).toBe(SMART_MODEL);
    expect(view.render.validatorModelUsed).toBe(SMART_MODEL);
    expect(view.render.requestedTier).toBe('smart');
    expect(view.render.promptVersion).toBe('tailor-v1/entail-v1');
    expect(renders.rows).toHaveLength(1);
  });

  it('does not re-read the current master when regenerating', async () => {
    const { service, master } = build();

    await service.create('u1', 'j1');
    // The user edits their master CV; m2 becomes current.
    master.getCurrent.mockResolvedValue(masterV2 as never);

    await service.regenerate('u1', 'row1');

    // Spec §4.2: the pin never follows is_current. Regeneration must still use m1.
    expect(master.getVersion).toHaveBeenLastCalledWith('u1', 'm1');
  });

  it('builds a later revision from the pinned facts, not the edited master', async () => {
    const { service, master, tailor } = build();

    await service.create('u1', 'j1');
    // The user edits their master CV after reviewing revision 1; m2 becomes current.
    master.getCurrent.mockResolvedValue(masterV2 as never);

    await service.regenerate('u1', 'row1');

    // Asserting on the facts actually fed to generation, not on an object already returned:
    // a stale-object assertion would stay green even if the pin were removed entirely.
    const factsUsed = tailor.tailor.mock.calls[1][0].facts;
    expect(factsUsed).toEqual([{ factId: 'f1', text: 'Senior Developer at Acme', kind: 'role' }]);
  });

  it('snapshots the facts as used so a render stays reproducible', async () => {
    const { service } = build();

    const view = await service.create('u1', 'j1');

    expect(view.render.factsSnapshot).toHaveLength(1);
    expect(view.render.factsSnapshot[0].factId).toBe('f1');
  });

  it('regenerate produces revision 2', async () => {
    const { service } = build();

    await service.create('u1', 'j1');
    const second = await service.regenerate('u1', 'row1');

    expect(second.render.revisionNo).toBe(2);
  });

  it('returns the existing render instead of spending a second generation', async () => {
    const { service, tailor } = build();

    await service.create('u1', 'j1');
    await service.regenerate('u1', 'row1');
    await service.regenerate('u1', 'row1');

    // Three calls, but revision 2 already existed on the third, so only two generations.
    expect(tailor.tailor).toHaveBeenCalledTimes(2);
  });

  it('surfaces the generation error and sets generation_failed', async () => {
    const tailor = {
      tailor: jest.fn(async () => {
        throw new Error('ai-microservice unreachable');
      }),
    };
    const { service, applications } = build({ tailor });

    await expect(service.create('u1', 'j1')).rejects.toThrow('ai-microservice unreachable');

    // Spec §5: never left stuck in `generating`, and the error is retained.
    expect(applications.rows[0].state).toBe('generation_failed');
    expect(applications.rows[0].stateError).toMatch(/unreachable/);
  });

  it('sets in_review on success', async () => {
    const { service, applications } = build();

    await service.create('u1', 'j1');

    expect(applications.rows[0].state).toBe('in_review');
  });

  it('409s when the job was never parsed', async () => {
    const jobs = { get: jest.fn(async () => ({ job: { ...job, parsed: null } })) };
    const { service } = build({ jobs });

    await expect(service.create('u1', 'j1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('409s when the user has no master CV', async () => {
    const master = { getCurrent: jest.fn(async () => null), getVersion: jest.fn(async () => null) };
    const { service } = build({ master });

    await expect(service.create('u1', 'j1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('raises rather than degrading when the pinned master version has vanished', async () => {
    const { service, master } = build();

    await service.create('u1', 'j1');
    master.getVersion.mockResolvedValue(null as never);

    // Losing the pin means the render is no longer reproducible: that is data loss.
    await expect(service.regenerate('u1', 'row1')).rejects.toThrow(/no longer exists/);
  });

  it('surfaces bullets needing confirmation', async () => {
    const entail = {
      validate: jest.fn(async (bullets: { text: string; sourceFactId: string }[]) => ({
        bullets: bullets.map((b) => ({
          ...b,
          targetRequirement: null,
          verdict: 'overreach',
          span: 'a team of 12',
        })),
        validatorModelUsed: SMART_MODEL,
        validatorPromptVersion: 'entail-v1',
      })),
    };
    const { service } = build({ entail });

    const view = await service.create('u1', 'j1');

    // Spec §6 layer 3: overreach becomes a confirm-or-drop chip, not a silent pass.
    expect(view.needsConfirmation).toHaveLength(1);
    expect(view.needsConfirmation[0].span).toBe('a team of 12');
  });

  it('computes an ai-tell score for the render', async () => {
    const { service } = build();

    const view = await service.create('u1', 'j1');

    expect(typeof view.render.aiTellScore).toBe('number');
  });

  it('404s another tenant application on read', async () => {
    const { service } = build();

    await service.create('u1', 'j1');

    await expect(service.get('intruder', 'row1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s another tenant application on regenerate', async () => {
    const { service } = build();

    await service.create('u1', 'j1');

    // Cross-tenant write must fail exactly like a missing row, revealing nothing.
    await expect(service.regenerate('intruder', 'row1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports no diff before the first approval rather than comparing unapproved revisions', async () => {
    const { service } = build();

    await service.create('u1', 'j1');
    const diff = await service.diff('u1', 'row1', 1);

    expect(diff).toEqual({ revisionNo: 1, baselineRevisionNo: null, noBaseline: true, hunks: [] });
  });

  it('reports no diff for later revisions before the first approval', async () => {
    const { service } = build();

    await service.create('u1', 'j1');
    await service.regenerate('u1', 'row1');
    const diff = await service.diff('u1', 'row1', 2);

    expect(diff).toEqual({ revisionNo: 2, baselineRevisionNo: null, noBaseline: true, hunks: [] });
  });

  it('404s a revision that does not exist', async () => {
    const { service } = build();

    await service.create('u1', 'j1');

    await expect(service.diff('u1', 'row1', 7)).rejects.toBeInstanceOf(NotFoundException);
  });
});
