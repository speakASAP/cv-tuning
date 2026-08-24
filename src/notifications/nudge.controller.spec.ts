import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NudgeController } from './nudge.controller';

const buildController = (opts: {
  application: any;
  job?: any;
  send?: jest.Mock;
  secret?: string;
}) => {
  const applications = {
    findOne: jest.fn(async () => opts.application),
    update: jest.fn(async (_id: string, patch: any) => Object.assign(opts.application, patch)),
  };
  const jobs = { findOne: jest.fn(async () => opts.job ?? null) };
  const client = { sendOutcomeNudge: opts.send ?? jest.fn(async () => undefined) };
  const controller = new NudgeController(
    applications as any,
    jobs as any,
    client as any,
    opts.secret ?? 'shhh',
    'owner@example.com',
  );
  return { controller, applications, client };
};

describe('POST /api/nudges/outcome', () => {
  it('sends the nudge and stamps nudgedAt', async () => {
    const application = {
      id: 'app-1',
      userId: 'user-1',
      jobId: 'job-1',
      state: 'downloaded',
      nudgedAt: null,
      outcome: null,
    };
    const { controller, client, applications } = buildController({
      application,
      job: { id: 'job-1', company: 'Acme' },
    });

    await controller.outcomeNudge('shhh', { context: { applicationId: 'app-1' } } as any);

    expect(client.sendOutcomeNudge).toHaveBeenCalledWith({
      applicationId: 'app-1',
      recipient: 'owner@example.com',
      company: 'Acme',
    });
    expect(applications.update).toHaveBeenCalledWith('app-1', { nudgedAt: expect.any(Date) });
  });

  it('rejects a caller without the shared secret', async () => {
    const { controller, client } = buildController({ application: { id: 'app-1' } });

    await expect(
      controller.outcomeNudge('wrong', { context: { applicationId: 'app-1' } } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('does not nudge twice about one application', async () => {
    const application = { id: 'app-1', state: 'downloaded', nudgedAt: new Date(), outcome: null };
    const { controller, client } = buildController({ application });

    await controller.outcomeNudge('shhh', { context: { applicationId: 'app-1' } } as any);

    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('does not nudge an application whose outcome is already recorded', async () => {
    const application = {
      id: 'app-1',
      state: 'marked_sent',
      nudgedAt: null,
      outcome: 'interview',
    };
    const { controller, client } = buildController({ application });

    await controller.outcomeNudge('shhh', { context: { applicationId: 'app-1' } } as any);

    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('raises when the callback carries no applicationId', async () => {
    const { controller } = buildController({ application: null });

    await expect(controller.outcomeNudge('shhh', { context: {} } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('raises when the application no longer exists', async () => {
    const { controller } = buildController({ application: null });

    await expect(
      controller.outcomeNudge('shhh', { context: { applicationId: 'gone' } } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('leaves nudgedAt unset when the send fails, so a retry can still deliver it', async () => {
    const application = {
      id: 'app-1',
      state: 'downloaded',
      nudgedAt: null,
      outcome: null,
      jobId: 'job-1',
    };
    const send = jest.fn(async () => {
      throw new Error('notifications down');
    });
    const { controller, applications } = buildController({ application, send });

    await expect(
      controller.outcomeNudge('shhh', { context: { applicationId: 'app-1' } } as any),
    ).rejects.toThrow(/notifications down/);
    expect(applications.update).not.toHaveBeenCalled();
  });
});
