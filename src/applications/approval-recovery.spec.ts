import { ConflictException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { bulletIdOf } from './bullet-identity';

/**
 * The two permanent dead ends in the approval path, and their fixes.
 *
 * Both were reachable through ordinary use and both left the user with an application they
 * could never complete, so each is reproduced here as the actual dead end BEFORE the escape
 * is asserted — a test that only checked the new happy path would stay green if the guard
 * were reintroduced.
 */

interface RenderRow {
  id: string;
  applicationId: string;
  revisionNo: number;
  markdown: string;
  factsSnapshot: unknown[];
  provenance: {
    bullets: {
      text: string;
      sourceFactId: string;
      targetRequirement: null;
      verdict: string;
      span: string | null;
      bulletId?: string;
    }[];
    droppedBullets: unknown[];
  };
  confirmedOverreach: {
    bulletId?: string;
    bulletText: string;
    decision: string;
    decidedBy: string;
    decidedAt: string;
  }[];
  createdBy: string;
  modelUsed: string;
  validatorModelUsed: string;
  requestedTier: string;
  degraded: boolean;
  promptVersion: string;
  idempotencyKey: string;
}

const supported = (text: string, factId: string) => ({
  text,
  sourceFactId: factId,
  targetRequirement: null as null,
  verdict: 'supported',
  span: null,
});

const overreach = (text: string, factId: string) => ({
  text,
  sourceFactId: factId,
  targetRequirement: null as null,
  verdict: 'overreach',
  span: text,
});

function makeHarness(opts: {
  state?: string;
  stateError?: string | null;
  bullets?: RenderRow['provenance']['bullets'];
  confirmed?: RenderRow['confirmedOverreach'];
  existingArtifacts?: { renderId: string; kind: string }[];
  pdfImpl?: jest.Mock;
} = {}) {
  const application: Record<string, unknown> = {
    id: 'app-1',
    userId: 'u1',
    state: opts.state ?? 'in_review',
    stateError: opts.stateError ?? null,
    revisionCount: 0,
  };
  const applications = {
    findOne: jest.fn(async () => ({ ...application })),
    update: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(application, patch);
      return { affected: 1 };
    }),
  };

  const rows: RenderRow[] = [
    {
      id: 'r1',
      applicationId: 'app-1',
      revisionNo: 1,
      markdown: '# Jane Doe\n\n## Experience\n\n### — Acme\n\n- a bullet',
      factsSnapshot: [],
      provenance: {
        bullets: opts.bullets ?? [supported('ran postgres in production', 'f1')],
        droppedBullets: [],
      },
      confirmedOverreach: opts.confirmed ?? [],
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
    // Handles both shapes the service uses: an exact (applicationId, revisionNo) lookup, and
    // an applicationId-only lookup ordered DESC for "the latest render".
    findOne: jest.fn(
      async ({ where }: { where: { applicationId: string; revisionNo?: number } }) => {
        const matched = rows
          .filter(
            (r) =>
              r.applicationId === where.applicationId &&
              (where.revisionNo === undefined || r.revisionNo === where.revisionNo),
          )
          .sort((a, b) => b.revisionNo - a.revisionNo);
        return matched[0] ?? null;
      },
    ),
    find: jest.fn(async ({ where }: { where: { applicationId: string } }) =>
      rows.filter((r) => r.applicationId === where.applicationId).sort((a, b) => b.revisionNo - a.revisionNo),
    ),
    save: jest.fn(async (draft: RenderRow) => {
      const row = { ...draft, id: `r${rows.length + 1}` };
      rows.push(row);
      return row;
    }),
  };

  const artifactRows: { renderId: string; kind: string }[] = [...(opts.existingArtifacts ?? [])];
  const artifacts = {
    find: jest.fn(async ({ where }: { where: { renderId: string } }) =>
      artifactRows.filter((a) => a.renderId === where.renderId),
    ),
    findOne: jest.fn(async ({ where }: { where: { renderId: string; kind: string } }) =>
      artifactRows.find((a) => a.renderId === where.renderId && a.kind === where.kind) ?? null,
    ),
    save: jest.fn(async (a: { renderId: string; kind: string }) => {
      artifactRows.push(a);
      return { ...a, id: `a${artifactRows.length}` };
    }),
  };

  const file = (ext: string) => ({
    content: Buffer.from(`fake-${ext}`),
    sha256: `sha-${ext}`,
    mimeType: `application/${ext}`,
    filename: `cv.${ext}`,
  });
  const pdf = { render: opts.pdfImpl ?? jest.fn(async () => file('pdf')) };
  const docx = { render: jest.fn(async () => file('docx')) };
  const storage = {
    putObject: jest.fn(async () => 'key'),
    getObject: jest.fn(async () => Buffer.from('x')),
  };

  const service = new ApplicationsService(
    applications as never,
    renders as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { find: jest.fn(async () => []), save: jest.fn() } as never,
    artifacts as never,
    pdf as never,
    docx as never,
    storage as never,
    // Phase 5: not exercised here, but a real double so an unexpected call fails loudly.
    { startOutcomeWatch: jest.fn(), deliverSignal: jest.fn() } as never,
  );

  return { service, applications, renders, artifacts, artifactRows, pdf, docx, storage, application, rows };
}

describe('DEFECT 1 — export failure at approve must be recoverable', () => {
  it('keeps approval absolute after an export failure while allowing a new review edit', async () => {
    // The failed export remains recoverable through retryExport below. A deliberate new edit is
    // separately allowed to reopen review, so a person can revise an approved CV rather than
    // being trapped behind the old immutable-approved workflow.
    const { service, application } = makeHarness({
      pdfImpl: jest.fn(async () => {
        throw new Error('minio unreachable');
      }),
    });

    await expect(service.approve('u1', 'app-1')).rejects.toThrow('minio unreachable');

    // The CV is approved and the failure was recorded loudly, not swallowed.
    expect(application.state).toBe('approved');
    expect(application.stateError).toMatch(/export failed: minio unreachable/);

    // Re-approval is still not an idempotent setter: only an edit may reopen the state machine.
    await expect(service.approve('u1', 'app-1')).rejects.toBeInstanceOf(ConflictException);
    await service.edit('u1', 'app-1', '# Jane Doe\n\n## Experience\n\n### Acme\n\n- corrected manually');
    expect(application.state).toBe('in_review');
  });

  it('retryExport completes the half-finished transition and clears stateError', async () => {
    const pdfImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('minio unreachable'))
      .mockResolvedValue({
        content: Buffer.from('fake-pdf'),
        sha256: 'sha-pdf',
        mimeType: 'application/pdf',
        filename: 'cv.pdf',
      });
    const { service, application, artifactRows } = makeHarness({ pdfImpl });

    await expect(service.approve('u1', 'app-1')).rejects.toThrow('minio unreachable');

    const recovered = await service.retryExport('u1', 'app-1');

    // Asserted through the real downstream state, not a string: the artifacts exist and the
    // "approved but export failed" marker is gone, so the two outcomes stay distinguishable.
    expect(artifactRows.map((a) => a.kind).sort()).toEqual(['docx', 'pdf']);
    expect(recovered.stateError).toBeNull();
    expect(application.state).toBe('approved');

    // The recovered file is genuinely downloadable — the actual thing the user was denied.
    await expect(service.download('u1', 'app-1', 1, 'pdf')).resolves.toMatchObject({
      artifact: expect.objectContaining({ kind: 'pdf' }),
    });
  });

  it('resumes a PARTIAL export instead of re-rendering the format that already succeeded', async () => {
    // PDF succeeded, DOCX did not. Re-rendering the PDF would produce a second file for a
    // render that already has one — the spec §6.3 divergence the (renderId, kind) unique
    // constraint exists to prevent — so the retry must skip it.
    const pdf = jest.fn(async () => ({
      content: Buffer.from('fake-pdf'),
      sha256: 'sha-pdf',
      mimeType: 'application/pdf',
      filename: 'cv.pdf',
    }));
    const { service, artifacts, artifactRows } = makeHarness({
      state: 'approved',
      stateError: 'export failed: docx writer blew up',
      existingArtifacts: [{ renderId: 'r1', kind: 'pdf' }],
      pdfImpl: pdf,
    });

    await service.retryExport('u1', 'app-1');

    expect(pdf).not.toHaveBeenCalled();
    expect(artifacts.save).toHaveBeenCalledTimes(1);
    expect(artifactRows.map((a) => a.kind).sort()).toEqual(['docx', 'pdf']);
  });

  it('a retry that fails again re-records the error and re-throws, never tidies the state', async () => {
    const { service, application } = makeHarness({
      state: 'approved',
      stateError: 'export failed: minio unreachable',
      pdfImpl: jest.fn(async () => {
        throw new Error('minio still unreachable');
      }),
    });

    await expect(service.retryExport('u1', 'app-1')).rejects.toThrow('minio still unreachable');
    expect(application.stateError).toMatch(/export failed: minio still unreachable/);
    expect(application.state).toBe('approved');
  });

  it('refuses to retry an application that already has BOTH artifacts', async () => {
    // The guarantee the approve() guard protects. A complete artifact set means the user may
    // already hold those files; regenerating them is exactly the spec §6.3 divergence.
    const { service, pdf, docx } = makeHarness({
      state: 'approved',
      stateError: 'export failed: a stale marker',
      existingArtifacts: [
        { renderId: 'r1', kind: 'pdf' },
        { renderId: 'r1', kind: 'docx' },
      ],
    });

    await expect(service.retryExport('u1', 'app-1')).rejects.toThrow(/already has both/i);
    expect(pdf.render).not.toHaveBeenCalled();
    expect(docx.render).not.toHaveBeenCalled();
  });

  it('refuses to retry a DOWNLOADED application', async () => {
    // The user demonstrably holds a file from this render. Nothing may be regenerated for it,
    // whatever `stateError` happens to say.
    const { service, pdf } = makeHarness({
      state: 'downloaded',
      stateError: 'export failed: something',
      existingArtifacts: [{ renderId: 'r1', kind: 'pdf' }],
    });

    await expect(service.retryExport('u1', 'app-1')).rejects.toThrow(/downloaded/);
    expect(pdf.render).not.toHaveBeenCalled();
  });

  it('refuses to retry an application whose export never failed', async () => {
    // Without a `stateError` there is no half-finished transition to complete, so this would
    // be a second export of a healthy approval — a re-approval through a side door.
    const { service, pdf } = makeHarness({ state: 'approved', stateError: null });
    await expect(service.retryExport('u1', 'app-1')).rejects.toThrow(/no recorded export failure/i);
    expect(pdf.render).not.toHaveBeenCalled();
  });

  it('refuses to retry an application still in_review', async () => {
    const { service } = makeHarness({ state: 'in_review' });
    await expect(service.retryExport('u1', 'app-1')).rejects.toThrow(/in_review/);
  });

  it('approve() itself still refuses an already-approved application', async () => {
    // Unchanged: recovery went into its own entry point precisely so this guard could stay
    // absolute rather than growing a conditional the next reader has to reason about.
    const { service } = makeHarness({ state: 'approved', stateError: 'export failed: x' });
    await expect(service.approve('u1', 'app-1')).rejects.toThrow(/cannot be approved/);
  });
});

describe('DEFECT 2 — two identical-text overreach bullets must be separately decidable', () => {
  const TWIN = 'improved system reliability';
  const twins = () => [overreach(TWIN, 'f1'), overreach(TWIN, 'f2')];

  it('reproduces the dead end: deciding one twin used to decide neither the other nor itself twice', async () => {
    const { service, rows } = makeHarness({ bullets: twins() });

    // Under text equality both decisions landed on the same bullet and the gate never opened.
    // With ids they are two distinct claims, so the SECOND is still unresolved after the first.
    await service.confirmClaim('u1', 'app-1', 1, bulletIdOf({ sourceFactId: 'f1' }), 'confirm');

    const afterFirst = rows[rows.length - 1];
    expect(afterFirst.confirmedOverreach).toHaveLength(1);
    expect(afterFirst.confirmedOverreach[0].bulletId).toBe(bulletIdOf({ sourceFactId: 'f1' }));
    // The audit trail still records the human-readable text alongside the id.
    expect(afterFirst.confirmedOverreach[0].bulletText).toBe(TWIN);
  });

  it('blocks approval while only ONE of two identical-text overreach bullets is confirmed', async () => {
    const { service } = makeHarness({
      bullets: twins(),
      confirmed: [
        {
          bulletId: bulletIdOf({ sourceFactId: 'f1' }),
          bulletText: TWIN,
          decision: 'confirm',
          decidedBy: 'u1',
          decidedAt: 'now',
        },
      ],
    });

    await expect(service.approve('u1', 'app-1')).rejects.toThrow(/still need a confirm-or-drop/);
  });

  it('opens the gate once BOTH twins are confirmed — the previously unreachable state', async () => {
    const { service, application } = makeHarness({
      bullets: twins(),
      confirmed: [
        { bulletId: bulletIdOf({ sourceFactId: 'f1' }), bulletText: TWIN, decision: 'confirm', decidedBy: 'u1', decidedAt: 'now' },
        { bulletId: bulletIdOf({ sourceFactId: 'f2' }), bulletText: TWIN, decision: 'confirm', decidedBy: 'u1', decidedAt: 'now' },
      ],
    });

    await service.approve('u1', 'app-1');
    expect(application.state).toBe('approved');
  });

  it('dropping one twin removes ONLY that bullet, leaving its namesake in the render', async () => {
    const { service, rows } = makeHarness({ bullets: twins() });

    await service.confirmClaim('u1', 'app-1', 1, bulletIdOf({ sourceFactId: 'f2' }), 'drop');

    const saved = rows[rows.length - 1];
    expect(saved.provenance.bullets.map((b) => b.sourceFactId)).toEqual(['f1']);
  });

  it('a LEGACY render with no stored bulletId is still decidable, addressed by the same id', async () => {
    // `provenance` is persisted jsonb. This row is exactly what the database already holds.
    const legacy = [
      { text: 'ran postgres', sourceFactId: 'f1', targetRequirement: null as null, verdict: 'overreach', span: 'postgres' },
    ];
    const { service, rows } = makeHarness({ bullets: legacy });

    await service.confirmClaim('u1', 'app-1', 1, bulletIdOf({ sourceFactId: 'f1' }), 'confirm');

    expect(rows[rows.length - 1].confirmedOverreach[0].bulletId).toBe(bulletIdOf({ sourceFactId: 'f1' }));
  });

  it('a LEGACY confirmedOverreach row (bulletText only) still clears its claim', async () => {
    // A human decision recorded before this field existed is still a real decision; forcing
    // the user to re-make it would be a regression they experience as data loss.
    const { service, application } = makeHarness({
      bullets: [overreach('ran postgres', 'f1')],
      confirmed: [{ bulletText: 'ran postgres', decision: 'confirm', decidedBy: 'u1', decidedAt: 'then' }],
    });

    await service.approve('u1', 'app-1');
    expect(application.state).toBe('approved');
  });

  it('a LEGACY confirmedOverreach row does NOT clear an ambiguous pair of twins', async () => {
    // The row cannot say which twin was decided. Clearing either would silently approve a
    // claim the user never ruled on, so the gate stays shut and they re-decide.
    const { service } = makeHarness({
      bullets: twins(),
      confirmed: [{ bulletText: TWIN, decision: 'confirm', decidedBy: 'u1', decidedAt: 'then' }],
    });

    await expect(service.approve('u1', 'app-1')).rejects.toThrow(/still need a confirm-or-drop/);
  });

  it('404s a decision aimed at a bullet id this render does not contain', async () => {
    const { service } = makeHarness({ bullets: twins() });
    await expect(
      service.confirmClaim('u1', 'app-1', 1, bulletIdOf({ sourceFactId: 'f99' }), 'confirm'),
    ).rejects.toThrow(/no bullet/i);
  });
});
