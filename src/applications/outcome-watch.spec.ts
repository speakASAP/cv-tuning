import { ApplicationsService } from './applications.service';

// Fakes for the collaborators `download` actually touches; everything else stays null so an
// unexpected new call fails loudly instead of passing against a stub.
const buildDownloadService = (opts: {
  state: string;
  bpcpInstanceId: string | null;
  startOutcomeWatch: jest.Mock;
}) => {
  const stored: any = {
    id: 'app-1',
    userId: 'user-1',
    state: opts.state,
    bpcpInstanceId: opts.bpcpInstanceId,
  };
  const applications = {
    findOne: jest.fn(async () => stored),
    update: jest.fn(async (_id: string, patch: any) => Object.assign(stored, patch)),
  };
  const renders = { findOne: jest.fn(async () => ({ id: 'render-1', revisionNo: 1 })) };
  const artifacts = {
    findOne: jest.fn(async () => ({ minioKey: 'k', byteSize: 3, kind: 'pdf' })),
  };
  const storage = { getObject: jest.fn(async () => Buffer.from('pdf')) };

  // Real parameter order from applications.service.ts, with `bpcp` appended in Task 3.
  const service = new ApplicationsService(
    applications as any,
    renders as any,
    null as any, // jobs
    null as any, // master
    null as any, // tailor
    null as any, // entail
    null as any, // reviseService
    null as any, // chats
    artifacts as any,
    null as any, // pdf
    null as any, // docx
    storage as any,
    { startOutcomeWatch: opts.startOutcomeWatch, deliverSignal: jest.fn() } as any,
  );
  return { service, stored, applications };
};

describe('download starts the outcome watch', () => {
  it('records the instance id alongside the state change', async () => {
    const startOutcomeWatch = jest.fn(async () => 'inst-7');
    const { service, stored } = buildDownloadService({
      state: 'approved',
      bpcpInstanceId: null,
      startOutcomeWatch,
    });

    await service.download('user-1', 'app-1', 1, 'pdf');

    expect(startOutcomeWatch).toHaveBeenCalledWith('app-1', 'user-1');
    expect(stored.state).toBe('downloaded');
    expect(stored.bpcpInstanceId).toBe('inst-7');
  });

  it('does not start a second watch on a repeat download', async () => {
    const startOutcomeWatch = jest.fn(async () => 'inst-8');
    const { service } = buildDownloadService({
      state: 'downloaded',
      bpcpInstanceId: 'inst-7',
      startOutcomeWatch,
    });

    await service.download('user-1', 'app-1', 1, 'pdf');

    expect(startOutcomeWatch).not.toHaveBeenCalled();
  });

  it('still returns the file when BPCP is down, because a nudge is not worth failing a download', async () => {
    const startOutcomeWatch = jest.fn(async () => {
      throw new Error('bpcp unreachable');
    });
    const { service, stored } = buildDownloadService({
      state: 'approved',
      bpcpInstanceId: null,
      startOutcomeWatch,
    });

    const result = await service.download('user-1', 'app-1', 1, 'pdf');

    expect(result.content.toString()).toBe('pdf');
    expect(stored.state).toBe('downloaded');
    expect(stored.bpcpInstanceId).toBeNull();
  });
});
