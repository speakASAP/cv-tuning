import { ApplicationsController } from './applications.controller';

const authed = (id = 'u1') => ({ user: { id, email: 'a@b.c' } }) as never;

describe('ApplicationsController', () => {
  let applications: any;
  let controller: ApplicationsController;

  beforeEach(() => {
    applications = {
      create: jest.fn(async () => ({ render: { id: 'r1' }, needsConfirmation: [] })),
      regenerate: jest.fn(async () => ({ render: { id: 'r2' }, needsConfirmation: [] })),
      list: jest.fn(async () => []),
      get: jest.fn(async () => ({ id: 'a1' })),
      listRenders: jest.fn(async () => []),
      diff: jest.fn(async () => ({ revisionNo: 1, baselineRevisionNo: null, hunks: [] })),
      confirmClaim: jest.fn(async () => ({ render: { id: 'r3' }, needsConfirmation: [] })),
      retryExport: jest.fn(async () => ({ id: 'a1', state: 'approved', stateError: null })),
    };
    controller = new ApplicationsController(applications);
  });

  it('creates an application for the authenticated user', async () => {
    await controller.create(authed(), { jobId: 'j1' } as never);

    expect(applications.create).toHaveBeenCalledWith('u1', 'j1', undefined);
  });

  it('never reads userId from the request body', async () => {
    await controller.create(authed('real-user'), { jobId: 'j1', userId: 'attacker' } as never);

    expect(applications.create).toHaveBeenCalledWith('real-user', 'j1', undefined);
  });

  it('passes the requested render language through', async () => {
    await controller.create(authed(), { jobId: 'j1', renderLanguage: 'cs' } as never);

    expect(applications.create).toHaveBeenCalledWith('u1', 'j1', 'cs');
  });

  it('regenerates for the authenticated user', async () => {
    await controller.regenerate(authed(), 'a1');

    expect(applications.regenerate).toHaveBeenCalledWith('u1', 'a1');
  });

  it('lists only the caller applications', async () => {
    await controller.list(authed('u2'));

    expect(applications.list).toHaveBeenCalledWith('u2');
  });

  it('scopes a single read to the caller', async () => {
    await controller.get(authed('u2'), 'a1');

    expect(applications.get).toHaveBeenCalledWith('u2', 'a1');
  });

  it('scopes render listing to the caller', async () => {
    await controller.listRenders(authed('u2'), 'a1');

    expect(applications.listRenders).toHaveBeenCalledWith('u2', 'a1');
  });

  it('scopes a diff to the caller and passes the revision number', async () => {
    await controller.diff(authed('u2'), 'a1', 2);

    expect(applications.diff).toHaveBeenCalledWith('u2', 'a1', 2);
  });

  it('forwards the bulletId, not a bullet text, to confirmClaim', async () => {
    // Text was ambiguous between two identical-text bullets; the route must carry the id
    // through untouched or the second one is undecidable again.
    await controller.confirmClaim(authed('u2'), 'a1', 3, { bulletId: 'b:f7', decision: 'drop' } as never);

    expect(applications.confirmClaim).toHaveBeenCalledWith('u2', 'a1', 3, 'b:f7', 'drop');
  });

  it('scopes the export retry to the caller', async () => {
    await controller.retryExport(authed('u2'), 'a1');

    expect(applications.retryExport).toHaveBeenCalledWith('u2', 'a1');
  });
});

describe('outcome endpoints', () => {
  it('passes the token user id, never a body-supplied one, to markSent', async () => {
    const service = { markSent: jest.fn(async () => ({ state: 'marked_sent' })) };
    const controller = new ApplicationsController(service as any);

    await controller.markSent({ user: { id: 'user-1' } } as never, 'app-1', {});

    expect(service.markSent).toHaveBeenCalledWith('user-1', 'app-1', undefined);
  });

  it('parses a supplied sentAt into a Date before it reaches the service', async () => {
    const service = { markSent: jest.fn(async () => ({ state: 'marked_sent' })) };
    const controller = new ApplicationsController(service as any);

    await controller.markSent({ user: { id: 'user-1' } } as never, 'app-1', {
      sentAt: '2026-08-20T09:00:00.000Z',
    });

    expect(service.markSent).toHaveBeenCalledWith(
      'user-1',
      'app-1',
      new Date('2026-08-20T09:00:00.000Z'),
    );
  });

  it('forwards the outcome value', async () => {
    const service = { recordOutcome: jest.fn(async () => ({ outcome: 'offer' })) };
    const controller = new ApplicationsController(service as any);

    await controller.recordOutcome({ user: { id: 'user-1' } } as never, 'app-1', {
      outcome: 'offer',
    });

    expect(service.recordOutcome).toHaveBeenCalledWith('user-1', 'app-1', 'offer');
  });
});
