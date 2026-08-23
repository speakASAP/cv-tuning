import { ConflictException, NotFoundException } from '@nestjs/common';
import { JobsService } from './jobs.service';

const parsed = {
  title: 'Senior Engineer',
  company: 'Acme',
  language: 'en',
  requirements: [{ text: 'TypeScript', kind: 'must' as const, category: 'language' }],
};

describe('JobsService', () => {
  let repo: any;
  let fetcher: any;
  let parser: any;
  let scorer: any;
  let master: any;
  let service: JobsService;
  let stored: any[];

  beforeEach(() => {
    stored = [];
    repo = {
      create: jest.fn((v: any) => ({ id: 'j1', ...v })),
      save: jest.fn(async (v: any) => {
        stored.push(v);
        return v;
      }),
      findOne: jest.fn(async ({ where }: any) =>
        stored.find((j) => j.id === where.id && j.userId === where.userId) ?? null,
      ),
      find: jest.fn(async () => stored),
    };
    fetcher = { fetch: jest.fn(async () => ({ status: 'ok', text: 'a real posting' })) };
    parser = { parse: jest.fn(async () => parsed) };
    scorer = { score: jest.fn(async () => ({ score: 62, matches: [], gaps: [] })) };
    master = { getCurrent: jest.fn(async () => ({ master: { id: 'm1' }, facts: [{ factId: 'f1' }] })) };
    service = new JobsService(repo, fetcher, parser, scorer, master);
  });

  it('parses and stores requirements when the fetch succeeds', async () => {
    const view = await service.submitUrl('u1', 'https://jobs.example.com/1');

    expect(view.job.parsed).toEqual(parsed);
    expect(view.job.title).toBe('Senior Engineer');
    expect(view.pasteFallback).toBeUndefined();
  });

  it('persists a blocked job with no parsed requirements', async () => {
    fetcher.fetch.mockResolvedValueOnce({ status: 'blocked', text: '', reason: 'HTTP 403' });

    const view = await service.submitUrl('u1', 'https://jobs.example.com/1');

    expect(view.job.fetchStatus).toBe('blocked');
    expect(view.job.parsed).toBeUndefined();
    expect(parser.parse).not.toHaveBeenCalled();
  });

  it('returns the paste-fallback hint when a fetch is blocked', async () => {
    fetcher.fetch.mockResolvedValueOnce({ status: 'blocked', text: '', reason: 'HTTP 403' });

    const view = await service.submitUrl('u1', 'https://jobs.example.com/1');

    // Never a bare failure: the user is told exactly what to do next.
    expect(view.pasteFallback?.needed).toBe(true);
    expect(view.pasteFallback?.reason).toContain('403');
  });

  it('offers the paste fallback for a thin page too', async () => {
    fetcher.fetch.mockResolvedValueOnce({ status: 'thin', text: 'x', reason: 'only 1 characters' });

    expect((await service.submitUrl('u1', 'https://x/1')).pasteFallback?.needed).toBe(true);
  });

  it('accepts pasted text for a previously blocked job and re-parses it', async () => {
    fetcher.fetch.mockResolvedValueOnce({ status: 'blocked', text: '', reason: 'HTTP 403' });
    await service.submitUrl('u1', 'https://jobs.example.com/1');

    const view = await service.supplyText('u1', 'j1', 'the pasted posting');

    expect(view.job.fetchStatus).toBe('ok');
    expect(view.job.source).toBe('paste');
    expect(view.job.parsed).toEqual(parsed);
    expect(view.pasteFallback).toBeUndefined();
  });

  it('accepts a pasted job with no URL at all', async () => {
    const view = await service.submitText('u1', 'pasted posting');

    expect(view.job.url).toBeNull();
    expect(view.job.source).toBe('paste');
  });

  it('scores against the current master CV', async () => {
    await service.submitUrl('u1', 'https://jobs.example.com/1');

    const report = await service.score('u1', 'j1');

    expect(report.score).toBe(62);
    expect(scorer.score).toHaveBeenCalledWith(parsed.requirements, [{ factId: 'f1' }]);
  });

  it('409s scoring when the user has no master CV', async () => {
    await service.submitUrl('u1', 'https://jobs.example.com/1');
    master.getCurrent.mockResolvedValueOnce(null);

    await expect(service.score('u1', 'j1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('409s scoring a job whose posting was never readable', async () => {
    fetcher.fetch.mockResolvedValueOnce({ status: 'blocked', text: '', reason: 'HTTP 403' });
    await service.submitUrl('u1', 'https://jobs.example.com/1');

    // Actionable, not a 500: the user needs to paste the text.
    await expect(service.score('u1', 'j1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s a job belonging to another user', async () => {
    await service.submitUrl('u1', 'https://jobs.example.com/1');

    await expect(service.get('someone-else', 'j1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s supplying text to another user’s job', async () => {
    await service.submitUrl('u1', 'https://jobs.example.com/1');

    await expect(service.supplyText('someone-else', 'j1', 'text')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sets an expiry on the retained posting text', async () => {
    const view = await service.submitUrl('u1', 'https://jobs.example.com/1');

    expect(view.job.expiresAt).toBeInstanceOf(Date);
    expect(view.job.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not store a job when parsing throws', async () => {
    parser.parse.mockRejectedValueOnce(new Error('model exploded'));

    await expect(service.submitUrl('u1', 'https://jobs.example.com/1')).rejects.toThrow('model exploded');
    expect(stored).toHaveLength(0);
  });
});
