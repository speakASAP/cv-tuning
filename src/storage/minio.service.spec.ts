import { MinioService } from './minio.service';

const config = {
  endpoint: 'http://minio.local:9000',
  accessKey: 'ak',
  secretKey: 'sk',
  bucket: 'cv-uploads',
};

describe('MinioService delete/exists', () => {
  it('objectExists returns true on 200 and false on 404', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 404 });
    const service = new MinioService(config as never, fetchImpl as never);
    await expect(service.objectExists('k')).resolves.toBe(true);
    await expect(service.objectExists('k')).resolves.toBe(false);
  });

  it('objectExists raises on any other status rather than guessing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 500, text: async () => 'boom' });
    const service = new MinioService(config as never, fetchImpl as never);
    await expect(service.objectExists('k')).rejects.toThrow('500');
  });

  it('deleteObject verifies the object is gone after the DELETE', async () => {
    const calls: string[] = [];
    const fetchImpl = jest.fn(async (_url: unknown, init: any) => {
      calls.push(init.method);
      if (init.method === 'DELETE') return { status: 204 } as never;
      return { status: 404 } as never; // HEAD verify: gone
    });
    const service = new MinioService(config as never, fetchImpl as never);
    await expect(service.deleteObject('k')).resolves.toBeUndefined();
    expect(calls).toEqual(['DELETE', 'HEAD']);
  });

  it('deleteObject raises when the object is still present after a "successful" DELETE', async () => {
    const fetchImpl = jest.fn(async (_url: unknown, init: any) => {
      if (init.method === 'DELETE') return { status: 204 } as never;
      return { status: 200 } as never; // HEAD verify: STILL THERE
    });
    const service = new MinioService(config as never, fetchImpl as never);
    await expect(service.deleteObject('k')).rejects.toThrow('still present');
  });

  it('deleteObject raises on a non-2xx DELETE', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 403, text: async () => 'denied' }) as never);
    const service = new MinioService(config as never, fetchImpl as never);
    await expect(service.deleteObject('k')).rejects.toThrow('403');
  });
});
