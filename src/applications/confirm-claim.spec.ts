import { ConflictException, NotFoundException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { bulletIdOf } from './bullet-identity';

interface RenderRow {
  id: string;
  applicationId: string;
  revisionNo: number;
  markdown: string;
  factsSnapshot: unknown[];
  provenance: { bullets: { text: string; sourceFactId: string; targetRequirement: null; verdict: string; span: string | null; bulletId?: string }[]; droppedBullets: unknown[] };
  confirmedOverreach: { bulletId?: string; bulletText: string; decision: string; decidedBy: string; decidedAt: string }[];
  createdBy: string;
  modelUsed: string;
  validatorModelUsed: string;
  requestedTier: string;
  degraded: boolean;
  promptVersion: string;
  idempotencyKey: string;
}

const OVERREACH_A = {
  text: 'led a team of 12 engineers',
  sourceFactId: 'f1',
  targetRequirement: null,
  verdict: 'overreach',
  span: 'a team of 12',
};
const OVERREACH_B = {
  text: 'cut infra costs by 40%',
  sourceFactId: 'f2',
  targetRequirement: null,
  verdict: 'overreach',
  span: '40%',
};

/** A minimal, real in-memory `cv_render` store: confirmClaim's own re-read logic under test. */
function makeService(opts: { state?: string } = {}) {
  const application = { id: 'app-1', userId: 'u1', state: opts.state ?? 'in_review' };
  const applications = {
    findOne: jest.fn().mockResolvedValue(application),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const rows: RenderRow[] = [
    {
      id: 'r1',
      applicationId: 'app-1',
      revisionNo: 1,
      markdown: '# Jane Doe\n\n## Tailored Highlights\n\n- led a team of 12 engineers\n- cut infra costs by 40%',
      factsSnapshot: [],
      provenance: { bullets: [OVERREACH_A, OVERREACH_B], droppedBullets: [] },
      confirmedOverreach: [],
      createdBy: 'ai',
      modelUsed: 'm',
      validatorModelUsed: 'v',
      requestedTier: 'smart',
      degraded: false,
      promptVersion: 'tailor-v1/entail-v1',
      idempotencyKey: 'app-1:1',
    },
  ];

  const renders = {
    findOne: jest.fn(async ({ where }: { where: { applicationId: string; revisionNo: number } }) =>
      rows.find((r) => r.applicationId === where.applicationId && r.revisionNo === where.revisionNo) ?? null,
    ),
    find: jest.fn(async ({ where }: { where: { applicationId: string } }) => {
      const matched = rows.filter((r) => r.applicationId === where.applicationId);
      // Service always requests DESC order for "latest" reads.
      return [...matched].sort((a, b) => b.revisionNo - a.revisionNo);
    }),
    save: jest.fn(async (draft: RenderRow) => {
      const row = { ...draft, id: `r${rows.length + 1}` };
      rows.push(row);
      return row;
    }),
  };

  const service = new ApplicationsService(
    applications as never,
    renders as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // Phase 5: not exercised here, but a real double so an unexpected call fails loudly.
    { startOutcomeWatch: jest.fn(), deliverSignal: jest.fn() } as never,
  );

  return { service, applications, renders, rows };
}

describe('ApplicationsService.confirmClaim', () => {
  it('resolves two overreach claims on the same source revision sequentially instead of colliding', async () => {
    const { service, rows } = makeService();

    // Both submitted against revision 1 — exactly what the UI showed before either decision.
    const afterA = await service.confirmClaim('u1', 'app-1', 1, bulletIdOf(OVERREACH_A), 'confirm');
    expect(afterA.render.revisionNo).toBe(2);

    // The client re-submits the second decision against the revision it now has (2), not the
    // stale value (1) — this is the corrected, expected caller behaviour.
    const afterB = await service.confirmClaim('u1', 'app-1', 2, bulletIdOf(OVERREACH_B), 'confirm');
    expect(afterB.render.revisionNo).toBe(3);

    // Both confirmations must be present in the final audit trail.
    expect(afterB.render.confirmedOverreach.map((c) => c.bulletText).sort()).toEqual(
      [OVERREACH_A.text, OVERREACH_B.text].sort(),
    );
    expect(rows).toHaveLength(3);
  });

  it('rejects a confirm-claim call against a revision that is no longer the latest, naming the real latest', async () => {
    const { service } = makeService();

    await service.confirmClaim('u1', 'app-1', 1, bulletIdOf(OVERREACH_A), 'confirm');

    // Second call still targets revision 1, exactly the stale-UI scenario from the review.
    await expect(service.confirmClaim('u1', 'app-1', 1, bulletIdOf(OVERREACH_B), 'confirm')).rejects.toThrow(
      /no longer the latest.*latest is 2/is,
    );
  });

  it('never surfaces a raw unique-constraint collision for two decisions against stale state', async () => {
    const { service, renders } = makeService();

    await service.confirmClaim('u1', 'app-1', 1, bulletIdOf(OVERREACH_A), 'confirm');
    const rejection = service.confirmClaim('u1', 'app-1', 1, bulletIdOf(OVERREACH_B), 'confirm');

    await expect(rejection).rejects.toBeInstanceOf(ConflictException);
    await expect(rejection).rejects.not.toThrow(/duplicate key|unique constraint/i);
    // Only one row was ever saved for the collision attempt (the first call's), never two
    // conflicting saves at revision 2.
    expect(renders.save).toHaveBeenCalledTimes(1);
  });

  it('rejects confirming a claim once the application has left in_review (e.g. approved)', async () => {
    const { service } = makeService({ state: 'approved' });

    await expect(service.confirmClaim('u1', 'app-1', 1, bulletIdOf(OVERREACH_A), 'confirm')).rejects.toThrow(
      /approved/,
    );
  });

  it('404s a confirm-claim call for a revision that does not exist', async () => {
    const { service } = makeService();

    await expect(service.confirmClaim('u1', 'app-1', 99, bulletIdOf(OVERREACH_A), 'confirm')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('carries confirmedOverreach forward on the new render rather than dropping it', async () => {
    const { service } = makeService();

    const result = await service.confirmClaim('u1', 'app-1', 1, bulletIdOf(OVERREACH_A), 'confirm');

    expect(result.render.confirmedOverreach).toHaveLength(1);
    expect(result.render.confirmedOverreach[0]).toMatchObject({
      bulletText: OVERREACH_A.text,
      decision: 'confirm',
      decidedBy: 'u1',
    });
  });

  it('drops the bullet from the new render when the decision is drop', async () => {
    const { service } = makeService();

    const result = await service.confirmClaim('u1', 'app-1', 1, bulletIdOf(OVERREACH_A), 'drop');

    const texts = result.render.provenance.bullets.map((b) => b.text);
    expect(texts).not.toContain(OVERREACH_A.text);
    expect(texts).toContain(OVERREACH_B.text);
  });
});
