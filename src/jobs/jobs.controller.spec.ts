import { JobsController } from './jobs.controller';

const authed = (id = 'u1') => ({ user: { id, email: 'a@b.c' } }) as never;

describe('JobsController', () => {
  let jobs: any;
  let controller: JobsController;

  beforeEach(() => {
    jobs = {
      submitUrl: jest.fn(async () => ({ job: { id: 'j1' } })),
      submitText: jest.fn(async () => ({ job: { id: 'j2' } })),
      supplyText: jest.fn(async () => ({ job: { id: 'j1' } })),
      list: jest.fn(async () => []),
      get: jest.fn(async () => ({ job: { id: 'j1' } })),
      score: jest.fn(async () => ({ score: 62, matches: [], gaps: [] })),
    };
    controller = new JobsController(jobs);
  });

  it('submits a URL for the authenticated user', async () => {
    await controller.submit(authed(), { url: 'https://jobs.example.com/1' } as never);

    expect(jobs.submitUrl).toHaveBeenCalledWith('u1', 'https://jobs.example.com/1');
  });

  it('never reads userId from the request body', async () => {
    await controller.submit(authed('real-user'), { url: 'https://x/1', userId: 'attacker' } as never);

    expect(jobs.submitUrl).toHaveBeenCalledWith('real-user', 'https://x/1');
  });

  it('accepts a pasted posting', async () => {
    await controller.paste(authed(), { text: 'a full posting body', url: 'https://x/1' } as never);

    expect(jobs.submitText).toHaveBeenCalledWith('u1', 'a full posting body', 'https://x/1');
  });

  it('supplies text for a blocked job', async () => {
    await controller.supplyText(authed(), 'j1', { text: 'pasted body' } as never);

    expect(jobs.supplyText).toHaveBeenCalledWith('u1', 'j1', 'pasted body');
  });

  it('lists only the caller’s jobs', async () => {
    await controller.list(authed('u9'));

    expect(jobs.list).toHaveBeenCalledWith('u9');
  });

  it('scopes a single job read to the caller', async () => {
    await controller.get(authed('u9'), 'j1');

    expect(jobs.get).toHaveBeenCalledWith('u9', 'j1');
  });

  it('returns the fit report from scoring', async () => {
    await expect(controller.score(authed(), 'j1')).resolves.toMatchObject({ score: 62 });
  });
});
