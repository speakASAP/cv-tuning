import { ApplicationsService } from './applications.service';

const render = {
  id: 'r1', applicationId: 'app-1', revisionNo: 2, markdown: '# Jane\n\n## Exp\n- did a thing',
  provenance: {
    bullets: [{ text: 'did a thing', sourceFactId: 'f1', targetRequirement: null, verdict: 'supported', span: null }],
    droppedBullets: [],
  },
  confirmedOverreach: [], factsSnapshot: [],
};

function makeService(
  opts: { pdfImpl?: jest.Mock; existingArtifacts?: unknown[]; render?: typeof render } = {},
) {
  const activeRender = opts.render ?? render;
  const applications = {
    findOne: jest.fn().mockResolvedValue({ id: 'app-1', userId: 'u1', state: 'in_review' }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const renders = {
    find: jest.fn().mockResolvedValue([activeRender]),
    findOne: jest.fn().mockResolvedValue(activeRender),
  };
  const artifacts = {
    find: jest.fn().mockResolvedValue(opts.existingArtifacts ?? []),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation((a) => Promise.resolve({ ...a, id: 'a1' })),
  };
  const file = (ext: string) => ({
    content: Buffer.from(`fake-${ext}`), sha256: `sha-${ext}`,
    mimeType: `application/${ext}`, filename: `cv.${ext}`,
  });
  const pdf = { render: opts.pdfImpl ?? jest.fn().mockResolvedValue(file('pdf')) };
  const docx = { render: jest.fn().mockResolvedValue(file('docx')) };
  const storage = { putObject: jest.fn().mockResolvedValue('key'), getObject: jest.fn().mockResolvedValue(Buffer.from('x')) };

  const service = new ApplicationsService(
    applications as never, renders as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, { find: jest.fn(), save: jest.fn() } as never,
    artifacts as never, pdf as never, docx as never, storage as never,
    // Phase 5: not exercised here, but a real double so an unexpected call fails loudly.
    { startOutcomeWatch: jest.fn(), deliverSignal: jest.fn() } as never,
  );
  return { service, applications, artifacts, pdf, docx, storage };
}

describe('export on approve', () => {
  it('generates BOTH formats when approval succeeds', async () => {
    const { service, pdf, docx } = makeService();
    await service.approve('u1', 'app-1');
    expect(pdf.render).toHaveBeenCalledTimes(1);
    expect(docx.render).toHaveBeenCalledTimes(1);
  });

  it('stores each artifact with its sha256', async () => {
    const { service, artifacts } = makeService();
    await service.approve('u1', 'app-1');
    const kinds = artifacts.save.mock.calls.map((c) => c[0].kind);
    expect(kinds.sort()).toEqual(['docx', 'pdf']);
    expect(artifacts.save.mock.calls[0][0].sha256).toMatch(/^sha-/);
  });

  it('does not regenerate artifacts that already exist', async () => {
    const { service, pdf, docx } = makeService({
      existingArtifacts: [{ renderId: 'r1', kind: 'pdf' }, { renderId: 'r1', kind: 'docx' }],
    });
    await service.approve('u1', 'app-1');
    expect(pdf.render).not.toHaveBeenCalled();
    expect(docx.render).not.toHaveBeenCalled();
  });

  it('leaves the application approved with an explicit error when export fails', async () => {
    const { service, applications } = makeService({
      pdfImpl: jest.fn().mockRejectedValue(new Error('pdfkit blew up')),
    });
    await expect(service.approve('u1', 'app-1')).rejects.toThrow('pdfkit blew up');
    const states = applications.update.mock.calls.map((c) => c[1].state);
    expect(states).toContain('approved');
    expect(applications.update).toHaveBeenLastCalledWith(
      'app-1',
      expect.objectContaining({ stateError: expect.stringContaining('pdfkit blew up') }),
    );
  });

  it('raises 404 for a missing artifact instead of silently regenerating it', async () => {
    const { service } = makeService();
    await expect(service.download('u1', 'app-1', 2, 'pdf')).rejects.toThrow(/not found/i);
  });

  it('refuses to approve a render with zero bullets rather than exporting a name-only CV', async () => {
    const zeroBulletRender = {
      ...render,
      markdown: '# Jane\n\n## Tailored Highlights',
      provenance: { bullets: [], droppedBullets: [] },
    };
    const { service, pdf, docx } = makeService({ render: zeroBulletRender });

    await expect(service.approve('u1', 'app-1')).rejects.toThrow(/no bullets/i);
    expect(pdf.render).not.toHaveBeenCalled();
    expect(docx.render).not.toHaveBeenCalled();
  });
});
