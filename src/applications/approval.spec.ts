import { ApplicationsService } from './applications.service';

const bullet = (text: string, verdict: string) => ({
  text, sourceFactId: 'f1', targetRequirement: null, verdict, span: verdict === 'supported' ? null : text,
});

function makeService(render: Record<string, unknown>, state = 'in_review') {
  const application = { id: 'app-1', userId: 'u1', state, revisionCount: 1 };
  const applications = {
    findOne: jest.fn().mockResolvedValue(application),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const renders = {
    find: jest.fn().mockResolvedValue([render]),
    findOne: jest.fn().mockResolvedValue(render),
    save: jest.fn().mockImplementation((r) => Promise.resolve({ ...r, id: 'r-new' })),
  };
  // 12 positional args — the full Phase 4 signature from Global Constraints.
  const service = new ApplicationsService(
    applications as never, renders as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, { find: jest.fn(), save: jest.fn() } as never,
    { find: jest.fn().mockResolvedValue([]), save: jest.fn() } as never,
    { render: jest.fn().mockResolvedValue({ content: Buffer.from('p'), sha256: 's', mimeType: 'application/pdf', filename: 'c.pdf' }) } as never,
    { render: jest.fn().mockResolvedValue({ content: Buffer.from('d'), sha256: 's', mimeType: 'application/docx', filename: 'c.docx' }) } as never,
    { putObject: jest.fn().mockResolvedValue('key'), getObject: jest.fn() } as never,
  );
  return { service, applications, renders };
}

const renderWith = (bullets: unknown[], confirmed: unknown[] = []) => ({
  id: 'r1', applicationId: 'app-1', revisionNo: 1, markdown: '- x',
  provenance: { bullets, droppedBullets: [] },
  confirmedOverreach: confirmed,
  factsSnapshot: [],
});

describe('approval gate', () => {
  it('blocks approval while an overreach bullet is unresolved, naming every one', async () => {
    const { service } = makeService(
      renderWith([bullet('Led a team of 12', 'overreach'), bullet('Ran Postgres', 'supported')]),
    );
    await expect(service.approve('u1', 'app-1')).rejects.toThrow(/Led a team of 12/);
  });

  it('refuses to re-approve an application that is not in_review, naming the current state', async () => {
    const { service } = makeService(renderWith([bullet('Ran Postgres', 'supported')]), 'approved');
    await expect(service.approve('u1', 'app-1')).rejects.toThrow(/approved/);
  });

  it('allows approval once every overreach bullet is confirmed', async () => {
    const { service, applications } = makeService(
      renderWith(
        [bullet('Led a team of 12', 'overreach')],
        [{ bulletText: 'Led a team of 12', decision: 'confirm', decidedBy: 'u1', decidedAt: 'now' }],
      ),
    );
    await service.approve('u1', 'app-1');
    expect(applications.update).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ state: 'approved' }),
    );
  });

  it('allows approval when nothing is flagged', async () => {
    const { service, applications } = makeService(renderWith([bullet('Ran Postgres', 'supported')]));
    await service.approve('u1', 'app-1');
    expect(applications.update).toHaveBeenCalledWith('app-1', expect.objectContaining({ state: 'approved' }));
  });

  it('does not block on `unsupported` — those are dropped, not confirmed', async () => {
    const { service, applications } = makeService(renderWith([bullet('x', 'unsupported')]));
    await service.approve('u1', 'app-1');
    expect(applications.update).toHaveBeenCalled();
  });

  it('records who confirmed a claim and when', async () => {
    const { service, renders } = makeService(renderWith([bullet('Led a team of 12', 'overreach')]));
    await service.confirmClaim('u1', 'app-1', 1, 'Led a team of 12', 'confirm');
    const saved = renders.save.mock.calls[0][0];
    expect(saved.confirmedOverreach[0]).toMatchObject({ bulletText: 'Led a team of 12', decidedBy: 'u1' });
    expect(saved.confirmedOverreach[0].decidedAt).toEqual(expect.any(String));
  });

  it('a dropped claim removes the bullet and does not count as confirmed', async () => {
    const { service, renders } = makeService(
      renderWith([bullet('Led a team of 12', 'overreach'), bullet('Ran Postgres', 'supported')]),
    );
    await service.confirmClaim('u1', 'app-1', 1, 'Led a team of 12', 'drop');
    const saved = renders.save.mock.calls[0][0];
    expect(saved.provenance.bullets).toHaveLength(1);
    expect(saved.markdown).not.toContain('Led a team of 12');
  });

  it('a confirm/drop render is attributed to the user, not the AI', async () => {
    const { service, renders } = makeService(renderWith([bullet('Led a team of 12', 'overreach')]));
    await service.confirmClaim('u1', 'app-1', 1, 'Led a team of 12', 'confirm');
    expect(renders.save.mock.calls[0][0].createdBy).toBe('user');
  });
});
