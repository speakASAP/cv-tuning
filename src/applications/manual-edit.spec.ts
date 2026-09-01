import { ConflictException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';

const source = {
  id: 'r1', applicationId: 'app-1', revisionNo: 1, markdown: '# Jane Doe\n\n## Experience\n\n### Acme\n\n- Built APIs',
  factsSnapshot: [{ factId: 'f1', text: 'Built APIs', kind: 'role' }],
  provenance: { bullets: [{ text: 'Built APIs', sourceFactId: 'f1', targetRequirement: null, verdict: 'supported', span: null }], droppedBullets: [] },
  confirmedOverreach: [{ bulletId: 'f1', bulletText: 'Built APIs', decision: 'confirm', decidedBy: 'u1', decidedAt: 'now' }],
  aiTellScore: 1, createdBy: 'ai', modelUsed: 'model', validatorModelUsed: 'validator', requestedTier: 'smart', degraded: false, promptVersion: 'tailor/entail', idempotencyKey: 'app-1:1',
};

function makeService(state = 'approved') {
  const application = { id: 'app-1', userId: 'u1', state, masterVersionId: 'mv-1', revisionCount: 0 };
  const rows = [source];
  const applications = {
    findOne: jest.fn().mockResolvedValue(application),
    update: jest.fn().mockImplementation(async (_id, patch) => Object.assign(application, patch)),
  };
  const entail = { validate: jest.fn() };
  const renders = {
    find: jest.fn().mockImplementation(async () => [...rows].sort((a, b) => b.revisionNo - a.revisionNo)),
    findOne: jest.fn().mockImplementation(async ({ where }: { where: { revisionNo: number } }) => rows.find((row) => row.revisionNo === where.revisionNo) ?? null),
    save: jest.fn().mockImplementation(async (draft) => { const row = { ...draft, id: 'r' + (rows.length + 1) }; rows.push(row); return row; }),
  };
  const master = {
    getVersion: jest.fn().mockResolvedValue({
      master: { id: 'mv-1', markdown: '# Jane Doe\n\n## Experience\n\n### Acme\n\n- Built APIs' },
      facts: [{ id: 'f1', payload: {}, kind: 'role' }],
    }),
  };
  const service = new ApplicationsService(
    applications as never, renders as never, {} as never, master as never, {} as never, entail as never,
    {} as never, {} as never, { find: jest.fn().mockResolvedValue([]), save: jest.fn() } as never,
    { render: jest.fn().mockResolvedValue({ content: Buffer.from('p'), sha256: 'p', mimeType: 'application/pdf' }) } as never,
    { render: jest.fn().mockResolvedValue({ content: Buffer.from('d'), sha256: 'd', mimeType: 'application/docx' }) } as never,
    { putObject: jest.fn().mockResolvedValue('key') } as never,
    { startOutcomeWatch: jest.fn(), deliverSignal: jest.fn() } as never,
  );
  return { service, applications, entail, rows };
}

describe('ApplicationsService.edit', () => {
  it('creates a trusted user-authored render, preserves audit data, and reopens approval', async () => {
    const { service, applications, entail, rows } = makeService();
    const markdown = '# Jane Doe\n\n## Experience\n\n### Acme\n\n- Personally revised bullet';
    const result = await service.edit('u1', 'app-1', markdown);
    expect(result.render).toMatchObject({ revisionNo: 2, markdown, createdBy: 'user', factsSnapshot: source.factsSnapshot, provenance: source.provenance, confirmedOverreach: source.confirmedOverreach, modelUsed: source.modelUsed, validatorModelUsed: source.validatorModelUsed, requestedTier: source.requestedTier, promptVersion: source.promptVersion, idempotencyKey: 'app-1:2' });
    expect(rows).toHaveLength(2);
    expect(entail.validate).not.toHaveBeenCalled();
    expect(applications.update).toHaveBeenCalledWith('app-1', { state: 'in_review', stateError: null });
  });

  it('rejects manual editing while generation is in progress', async () => {
    const { service } = makeService('generating');
    await expect(service.edit('u1', 'app-1', '# Jane')).rejects.toBeInstanceOf(ConflictException);
  });

  it('diffs the new render against its predecessor revision, not the master CV', async () => {
    const { service } = makeService();
    await service.edit('u1', 'app-1', '# Jane Doe\n\n## Experience\n\n### Acme\n\n- Updated API work');
    const diff = await service.diff('u1', 'app-1', 2);
    expect(diff).toMatchObject({ revisionNo: 2, baselineRevisionNo: 1 });
    expect(diff.hunks.length).toBeGreaterThan(0);
  });

  it('allows re-approving an edited application', async () => {
    const { service, applications } = makeService();
    await service.edit('u1', 'app-1', '# Jane Doe\n\n## Experience\n\n### Acme\n\n- Updated');
    await service.approve('u1', 'app-1');
    expect(applications.update).toHaveBeenCalledWith(
      'app-1', expect.objectContaining({ state: 'approved' }),
    );
  });

  it('diffs revision 1 against the pinned master CV', async () => {
    const { service } = makeService('in_review');
    const diff = await service.diff('u1', 'app-1', 1);
    expect(diff.baselineRevisionNo).toBeNull();
  });
});
