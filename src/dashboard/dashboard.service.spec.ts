import { DashboardService } from './dashboard.service';

/** A query-builder double returning canned grouped rows, matching TypeORM's fluent shape. */
const makeRepo = (stateRows: any[], outcomeRows: any[], replyRows: any[]) => {
  const builders = [stateRows, outcomeRows, replyRows];
  let call = 0;
  return {
    createQueryBuilder: jest.fn(() => {
      const rows = builders[call++];
      const builder: any = {
        select: jest.fn(() => builder),
        addSelect: jest.fn(() => builder),
        where: jest.fn(() => builder),
        andWhere: jest.fn(() => builder),
        groupBy: jest.fn(() => builder),
        getRawMany: jest.fn(async () => rows),
      };
      return builder;
    }),
  };
};

describe('summary', () => {
  it('builds the funnel from grouped state counts', async () => {
    const repo = makeRepo(
      [
        { state: 'in_review', count: '3' },
        { state: 'approved', count: '2' },
        { state: 'downloaded', count: '4' },
        { state: 'marked_sent', count: '5' },
      ],
      [
        { outcome: 'interview', count: '2' },
        { outcome: 'rejected', count: '1' },
      ],
      [],
    );
    const service = new DashboardService(repo as any);

    const summary = await service.summary('user-1');

    expect(summary.total).toBe(14);
    expect(summary.byState.downloaded).toBe(4);
    // The funnel is cumulative: an application sitting in marked_sent was necessarily
    // downloaded and approved on its way there, so each stage counts everything at or past it.
    expect(summary.funnel.approved).toBe(11);
    expect(summary.funnel.downloaded).toBe(9);
    expect(summary.funnel.sent).toBe(5);
  });

  it('reports every state and outcome key, so a zero renders as 0 rather than a hole', async () => {
    const repo = makeRepo([{ state: 'approved', count: '1' }], [], []);
    const service = new DashboardService(repo as any);

    const summary = await service.summary('user-1');

    expect(summary.byState.marked_sent).toBe(0);
    expect(summary.byOutcome.ghosted).toBe(0);
    expect(summary.byOutcome.offer).toBe(0);
  });

  it('returns a null interview rate when nothing has been sent, never zero', async () => {
    const repo = makeRepo([{ state: 'in_review', count: '2' }], [], []);
    const service = new DashboardService(repo as any);

    const summary = await service.summary('user-1');

    // 0% would read as "your CV is failing"; the honest answer is "no data yet".
    expect(summary.interviewRate).toBeNull();
  });

  it('computes the interview rate over sent applications', async () => {
    const repo = makeRepo(
      [{ state: 'marked_sent', count: '10' }],
      [{ outcome: 'interview', count: '3' }],
      [],
    );
    const service = new DashboardService(repo as any);

    const summary = await service.summary('user-1');

    expect(summary.interviewRate).toBeCloseTo(0.3);
  });

  it('counts an offer as an interview-or-better in the rate', async () => {
    const repo = makeRepo(
      [{ state: 'marked_sent', count: '10' }],
      [
        { outcome: 'interview', count: '2' },
        { outcome: 'offer', count: '1' },
      ],
      [],
    );
    const service = new DashboardService(repo as any);

    // An offer necessarily passed the interview stage; excluding it would under-report success.
    expect((await service.summary('user-1')).interviewRate).toBeCloseTo(0.3);
  });

  it('reports the median reply time in days, null when nothing has replied', async () => {
    const empty = makeRepo([{ state: 'marked_sent', count: '1' }], [], []);
    expect((await new DashboardService(empty as any).summary('user-1')).medianReplyDays).toBeNull();

    const withReplies = makeRepo(
      [{ state: 'marked_sent', count: '3' }],
      [{ outcome: 'interview', count: '3' }],
      [{ days: '2' }, { days: '6' }, { days: '10' }],
    );
    expect((await new DashboardService(withReplies as any).summary('user-1')).medianReplyDays).toBe(
      6,
    );
  });

  it('takes the mean of the middle two on an even count', async () => {
    const repo = makeRepo(
      [{ state: 'marked_sent', count: '4' }],
      [{ outcome: 'interview', count: '4' }],
      [{ days: '2' }, { days: '4' }, { days: '6' }, { days: '12' }],
    );
    expect((await new DashboardService(repo as any).summary('user-1')).medianReplyDays).toBe(5);
  });
});
