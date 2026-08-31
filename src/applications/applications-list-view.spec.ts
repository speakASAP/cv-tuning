import { ApplicationsService } from './applications.service';

/**
 * An application has no name of its own. Rendered from entity fields alone the list showed
 * one `state` per row, so several applications in the same state were indistinguishable —
 * a column reading "in_review, in_review, in_review". The position is what the user
 * recognises, so the list must carry it.
 */
describe('ApplicationsService.list', () => {
  const makeService = (applications: unknown[], jobs: unknown[]) =>
    new ApplicationsService(
      { find: jest.fn(async () => applications) } as never,
      {} as never,
      { list: jest.fn(async () => jobs) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  const application = (id: string, jobId: string) => ({
    id,
    jobId,
    userId: 'u1',
    state: 'in_review',
    stateError: null,
    outcome: null,
    renderLanguage: 'en',
    revisionCount: 2,
    createdAt: new Date('2026-08-30T10:00:00.000Z'),
  });

  it('names each application by its position so two in the same state stay distinguishable', async () => {
    const service = makeService(
      [application('a1', 'j1'), application('a2', 'j2')],
      [
        { id: 'j1', title: 'Product Marketing Lead', company: 'Northwind' },
        { id: 'j2', title: 'Growth Engineer', company: 'Contoso' },
      ],
    );

    const rows = await service.list('u1');

    expect(rows.map((row) => row.jobTitle)).toEqual(['Product Marketing Lead', 'Growth Engineer']);
    expect(rows.map((row) => row.jobCompany)).toEqual(['Northwind', 'Contoso']);
    // Both are in_review: the state alone could never have told them apart.
    expect(new Set(rows.map((row) => row.state))).toEqual(new Set(['in_review']));
  });

  it('exposes jobId so a saved job can be matched to the application already made from it', async () => {
    const service = makeService([application('a1', 'j1')], [{ id: 'j1', title: 'T', company: 'C' }]);

    expect((await service.list('u1'))[0].jobId).toBe('j1');
  });

  it('reports an unnamed position as null rather than inventing a title', async () => {
    const service = makeService([application('a1', 'j1')], [{ id: 'j1', title: null, company: null }]);

    const [row] = await service.list('u1');
    expect(row.jobTitle).toBeNull();
    expect(row.jobCompany).toBeNull();
  });

  it('does not leak the owning userId to the client', async () => {
    const service = makeService([application('a1', 'j1')], [{ id: 'j1', title: 'T', company: 'C' }]);

    expect((await service.list('u1'))[0]).not.toHaveProperty('userId');
  });

  it('reads every job once instead of per application', async () => {
    const jobs = { list: jest.fn(async () => [{ id: 'j1', title: 'T', company: 'C' }]) };
    const service = new ApplicationsService(
      { find: jest.fn(async () => [application('a1', 'j1'), application('a2', 'j1')]) } as never,
      {} as never,
      jobs as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.list('u1');

    expect(jobs.list).toHaveBeenCalledTimes(1);
  });
});
