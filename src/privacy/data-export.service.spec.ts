import { DataExportService } from './data-export.service';

describe('DataExportService', () => {
  const setup = () => {
    const repo = (rows: unknown[]) => ({ find: jest.fn(async () => rows), findOne: jest.fn(async () => rows[0] ?? null) });
    const profiles = { findOne: jest.fn(async () => ({ userId: 'u1', consentVersion: '2026-08-27' })) };
    const masters = repo([{ id: 'm1', userId: 'u1', version: 1 }]);
    const facts = repo([{ id: 'f1', masterId: 'm1' }]);
    const jobs = repo([{ id: 'j1', userId: 'u1' }]);
    const applications = repo([{ id: 'app1', userId: 'u1' }]);
    const renders = repo([{ id: 'r1', applicationId: 'app1' }]);
    const supplements = repo([{ id: 's1', applicationId: 'app1' }]);
    const chats = repo([{ id: 'c1', applicationId: 'app1' }]);
    const artifacts = {
      find: jest.fn(async (opts: any) => {
        if (opts?.where?.renderId) return [{ id: 'a1', renderId: 'r1', supplementId: null, kind: 'pdf', minioKey: 'cv/u1/app1/r1.pdf', sha256: 'sh', byteSize: 3, createdAt: new Date(0) }];
        if (opts?.where?.supplementId) return [{ id: 'a2', renderId: null, supplementId: 's1', kind: 'pdf', minioKey: 'supplements/u1/app1/cover.pdf', sha256: 'sh2', byteSize: 2, createdAt: new Date(0) }];
        return [];
      }),
    };
    const storage = { getObject: jest.fn(async () => Buffer.from('PDF')) };
    const service = new DataExportService(
      profiles as never, masters as never, facts as never, jobs as never,
      applications as never, renders as never, supplements as never, chats as never,
      artifacts as never, storage as never,
    );
    return { service, storage, artifacts };
  };

  it('exports the full graph for the user', async () => {
    const { service } = setup();
    const out = await service.export('u1');
    expect(out.userId).toBe('u1');
    expect(out.masters).toHaveLength(1);
    expect(out.facts).toHaveLength(1);
    expect(out.jobs).toHaveLength(1);
    expect(out.applications).toHaveLength(1);
    expect(out.renders).toHaveLength(1);
    expect(out.supplements).toHaveLength(1);
    expect(out.chats).toHaveLength(1);
    expect(out.artifacts).toHaveLength(2);
    expect(out.exportedAt).toEqual(expect.any(String));
  });

  it('includes both the artifact reference and its bytes', async () => {
    const { service } = setup();
    const out = await service.export('u1');
    const pdf = out.artifacts.find((a) => a.id === 'a1')!;
    expect(pdf.reference).toBe('cv/u1/app1/r1.pdf');
    expect(pdf.data).toBe(Buffer.from('PDF').toString('base64'));
    expect(pdf.dataError).toBeUndefined();
  });

  it('surfaces an unreadable artifact per-object instead of failing the export', async () => {
    const { service, storage } = setup();
    storage.getObject.mockRejectedValueOnce(new Error('MinIO GET returned 500'));
    const out = await service.export('u1');
    const failed = out.artifacts.find((a) => a.data === null)!;
    expect(failed.reference).toBeDefined();
    expect(failed.dataError).toContain('500');
    // The rest of the export is still produced.
    expect(out.artifacts.some((a) => a.data !== null)).toBe(true);
  });
});
