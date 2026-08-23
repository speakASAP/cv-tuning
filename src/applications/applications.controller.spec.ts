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
});
