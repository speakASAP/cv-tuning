import { AccountDeletionService } from './account-deletion.service';
import { CvApplicationEntity } from '../applications/entities/cv-application.entity';
import { CvRenderEntity } from '../applications/entities/cv-render.entity';
import { CvSupplementEntity } from '../applications/entities/cv-supplement.entity';
import { CvMasterEntity } from '../master/entities/cv-master.entity';

describe('AccountDeletionService', () => {
  const setup = () => {
    const storage = { deleteObject: jest.fn(async (_key: string) => undefined), getObject: jest.fn(), putObject: jest.fn() };

    const applications = { find: jest.fn(async () => [{ id: 'app1' }]) };
    const renders = { find: jest.fn(async () => [{ id: 'r1' }]) };
    const supplements = { find: jest.fn(async () => [{ id: 's1' }]) };
    const artifacts = {
      find: jest.fn(async (opts: any) => {
        if (opts?.where?.renderId) return [{ minioKey: 'cv/u1/app1/r1.pdf' }];
        if (opts?.where?.supplementId) return [{ minioKey: 'supplements/u1/app1/cover.pdf' }];
        return [];
      }),
    };
    const masters = { find: jest.fn(async () => [{ sourceRef: 'u1/original.pdf' }]) };

    const manager = {
      find: jest.fn(async (entity: unknown) => {
        if (entity === CvApplicationEntity) return [{ id: 'app1' }];
        if (entity === CvRenderEntity) return [{ id: 'r1' }];
        if (entity === CvSupplementEntity) return [{ id: 's1' }];
        if (entity === CvMasterEntity) return [{ id: 'm1' }];
        return [];
      }),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    const dataSource = { transaction: jest.fn(async (cb: any) => cb(manager)) };

    const service = new AccountDeletionService(
      dataSource as never,
      applications as never,
      renders as never,
      supplements as never,
      artifacts as never,
      masters as never,
      storage as never,
    );
    return { service, storage, dataSource, manager };
  };

  it('deletes every MinIO object before touching the database', async () => {
    const { service, storage, dataSource } = setup();
    const order: string[] = [];
    storage.deleteObject.mockImplementation(async (key: string) => {
      order.push(`minio:${key}`);
    });
    dataSource.transaction.mockImplementation(async (cb: any) => {
      order.push('db:transaction');
      return cb({ find: jest.fn(async () => []), delete: jest.fn(async () => ({ affected: 0 })) });
    });

    await service.deleteAccount('u1');

    // Both known object keys are deleted, and all deletions precede the DB transaction.
    expect(order).toContain('minio:cv/u1/app1/r1.pdf');
    expect(order).toContain('minio:supplements/u1/app1/cover.pdf');
    expect(order).toContain('minio:u1/original.pdf');
    expect(order.indexOf('db:transaction')).toBe(order.length - 1);
  });

  it('collects artifact keys and uploaded-master source refs, de-duplicated', async () => {
    const { service, storage } = setup();
    const report = await service.deleteAccount('u1');
    expect(report.deletedObjectKeys.sort()).toEqual(
      ['cv/u1/app1/r1.pdf', 'supplements/u1/app1/cover.pdf', 'u1/original.pdf'].sort(),
    );
    expect(storage.deleteObject).toHaveBeenCalledTimes(3);
  });

  it('deletes rows for every cv_ table inside one transaction', async () => {
    const { service, manager, dataSource } = setup();
    await service.deleteAccount('u1');
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    // artifacts (x2), chats, renders, supplements, applications, jobs, facts, masters, profile
    expect(manager.delete).toHaveBeenCalledTimes(10);
  });

  it('aborts the whole cascade if an object cannot be verifiably deleted', async () => {
    const { service, storage, dataSource } = setup();
    storage.deleteObject.mockRejectedValueOnce(new Error('object still present after DELETE'));
    await expect(service.deleteAccount('u1')).rejects.toThrow('still present');
    // The database half must never run once an object deletion is unconfirmed.
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
