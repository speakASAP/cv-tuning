import { ConflictException, NotFoundException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { CvApplicationEntity } from './entities/cv-application.entity';

/** Minimal repository double: one row, recording every update it is asked to apply. */
const makeApplicationsRepo = (row: Partial<CvApplicationEntity>) => {
  const stored = { id: 'app-1', userId: 'user-1', ...row } as CvApplicationEntity;
  const updates: Partial<CvApplicationEntity>[] = [];
  return {
    stored,
    updates,
    findOne: jest.fn(async ({ where }: any) =>
      where.id === stored.id && (where.userId === undefined || where.userId === stored.userId)
        ? stored
        : null,
    ),
    update: jest.fn(async (_id: string, patch: Partial<CvApplicationEntity>) => {
      updates.push(patch);
      Object.assign(stored, patch);
    }),
  };
};

const buildService = (repo: ReturnType<typeof makeApplicationsRepo>): ApplicationsService =>
  // Only the applications repository participates in these two methods; the remaining
  // collaborators are never reached, so passing null keeps the test honest — if a future edit
  // starts calling one, this test crashes loudly rather than quietly exercising a stub.
  new ApplicationsService(
    repo as any,
    null as any, // renders
    null as any, // jobs
    null as any, // master
    null as any, // tailor
    null as any, // entail
    null as any, // reviseService
    null as any, // chats
    null as any, // artifacts
    null as any, // pdf
    null as any, // docx
    null as any, // storage
    { startOutcomeWatch: jest.fn(), deliverSignal: jest.fn() } as any, // bpcp
  );

describe('markSent', () => {
  it('records the assertion and moves the state', async () => {
    const repo = makeApplicationsRepo({ state: 'downloaded', bpcpInstanceId: 'inst-1' });
    const service = buildService(repo);

    const result = await service.markSent('user-1', 'app-1');

    expect(result.state).toBe('marked_sent');
    expect(result.sentAt).toBeInstanceOf(Date);
  });

  it('refuses from a state that has no download behind it', async () => {
    const repo = makeApplicationsRepo({ state: 'in_review' });
    const service = buildService(repo);

    await expect(service.markSent('user-1', 'app-1')).rejects.toThrow(ConflictException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('is idempotent: marking an already-sent application does not move sentAt', async () => {
    const originalSentAt = new Date('2026-08-01T10:00:00.000Z');
    const repo = makeApplicationsRepo({ state: 'marked_sent', sentAt: originalSentAt });
    const service = buildService(repo);

    const result = await service.markSent('user-1', 'app-1');

    expect(result.sentAt).toEqual(originalSentAt);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('accepts a user-supplied send date, because the user may mark it days later', async () => {
    const repo = makeApplicationsRepo({ state: 'downloaded' });
    const service = buildService(repo);
    const backdated = new Date('2026-08-20T09:00:00.000Z');

    const result = await service.markSent('user-1', 'app-1', backdated);

    expect(result.sentAt).toEqual(backdated);
  });

  it('rejects a send date in the future rather than storing an impossible funnel entry', async () => {
    const repo = makeApplicationsRepo({ state: 'downloaded' });
    const service = buildService(repo);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await expect(service.markSent('user-1', 'app-1', future)).rejects.toThrow(/future/);
  });
});

describe('recordOutcome', () => {
  it('stores the outcome and its timestamp together', async () => {
    const repo = makeApplicationsRepo({ state: 'marked_sent', sentAt: new Date() });
    const service = buildService(repo);

    const result = await service.recordOutcome('user-1', 'app-1', 'interview');

    expect(result.outcome).toBe('interview');
    expect(result.outcomeAt).toBeInstanceOf(Date);
  });

  it('refuses an outcome before the user asserted the send', async () => {
    const repo = makeApplicationsRepo({ state: 'downloaded' });
    const service = buildService(repo);

    await expect(service.recordOutcome('user-1', 'app-1', 'interview')).rejects.toThrow(
      ConflictException,
    );
  });

  it('refuses an unknown outcome instead of persisting free text', async () => {
    const repo = makeApplicationsRepo({ state: 'marked_sent' });
    const service = buildService(repo);

    await expect(service.recordOutcome('user-1', 'app-1', 'ghosting')).rejects.toThrow(
      ConflictException,
    );
  });

  it('allows a correction: ghosted then interview overwrites and re-stamps', async () => {
    const repo = makeApplicationsRepo({
      state: 'marked_sent',
      outcome: 'ghosted',
      outcomeAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const service = buildService(repo);

    const result = await service.recordOutcome('user-1', 'app-1', 'interview');

    expect(result.outcome).toBe('interview');
    expect(result.outcomeAt!.getTime()).toBeGreaterThan(
      new Date('2026-08-01T00:00:00.000Z').getTime(),
    );
  });

  it('does not find another user application', async () => {
    const repo = makeApplicationsRepo({ state: 'marked_sent' });
    const service = buildService(repo);

    await expect(service.recordOutcome('someone-else', 'app-1', 'offer')).rejects.toThrow(
      NotFoundException,
    );
  });
});
