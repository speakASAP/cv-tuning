import { RetentionService } from './retention.service';

describe('RetentionService', () => {
  describe('expireJobRawText', () => {
    it('nulls raw_text on due jobs and saves them, keeping parsed', async () => {
      const due = [
        { id: 'j1', rawText: 'posting text', parsed: { requirements: [] } },
        { id: 'j2', rawText: 'more text', parsed: { requirements: [] } },
      ];
      const jobs = { find: jest.fn(async () => due), save: jest.fn(async () => due) };
      const service = new RetentionService(jobs as never, {} as never, {} as never, {} as never, {} as never);

      const result = await service.expireJobRawText(new Date('2026-08-27'));

      expect(result.expired).toBe(2);
      expect(due[0].rawText).toBeNull();
      expect(due[1].rawText).toBeNull();
      expect(due[0].parsed).toBeDefined();
      expect(jobs.save).toHaveBeenCalledWith(due);
    });

    it('does nothing when no job is due', async () => {
      const jobs = { find: jest.fn(async () => []), save: jest.fn() };
      const service = new RetentionService(jobs as never, {} as never, {} as never, {} as never, {} as never);
      const result = await service.expireJobRawText();
      expect(result.expired).toBe(0);
      expect(jobs.save).not.toHaveBeenCalled();
    });
  });

  describe('purgeOrphanedArtifacts', () => {
    const build = (artifactRows: unknown[], liveRenders: unknown[], liveSupplements: unknown[]) => {
      const storage = { deleteObject: jest.fn(async () => undefined) };
      const artifacts = {
        find: jest.fn(async () => artifactRows),
        delete: jest.fn(async () => ({ affected: 1 })),
      };
      const renders = { find: jest.fn(async () => liveRenders) };
      const supplements = { find: jest.fn(async () => liveSupplements) };
      const service = new RetentionService({} as never, artifacts as never, renders as never, supplements as never, storage as never);
      return { service, storage, artifacts };
    };

    it('purges an artifact whose render is gone, object before row', async () => {
      const { service, storage, artifacts } = build(
        [{ id: 'a1', renderId: 'dead', supplementId: null, minioKey: 'cv/u1/app1/r1.pdf' }],
        [],
        [],
      );
      const order: string[] = [];
      storage.deleteObject.mockImplementation(async () => { order.push('minio'); });
      artifacts.delete.mockImplementation(async () => { order.push('db'); return { affected: 1 }; });

      const result = await service.purgeOrphanedArtifacts();

      expect(result.purged).toBe(1);
      expect(result.keys).toEqual(['cv/u1/app1/r1.pdf']);
      expect(order).toEqual(['minio', 'db']);
    });

    it('keeps an artifact whose render is still live', async () => {
      const { service, storage } = build(
        [{ id: 'a1', renderId: 'r1', supplementId: null, minioKey: 'cv/u1/app1/r1.pdf' }],
        [{ id: 'r1' }],
        [],
      );
      const result = await service.purgeOrphanedArtifacts();
      expect(result.purged).toBe(0);
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('keeps a supplement artifact whose supplement is still live', async () => {
      const { service, storage } = build(
        [{ id: 'a2', renderId: null, supplementId: 's1', minioKey: 'supplements/u1/app1/cover.pdf' }],
        [],
        [{ id: 's1' }],
      );
      const result = await service.purgeOrphanedArtifacts();
      expect(result.purged).toBe(0);
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });
});
