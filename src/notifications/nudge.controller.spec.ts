import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NudgeController } from './nudge.controller';

// Real uuids: `cv_application.id` is a uuid column, and the controller now rejects anything
// else before the lookup, so a placeholder like 'app-1' would exercise the wrong path.
const APP_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_ID = '22222222-2222-4222-8222-222222222222';

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
      id: APP_ID,
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

    await controller.outcomeNudge('shhh', { context: { applicationId: APP_ID } } as any);

    expect(client.sendOutcomeNudge).toHaveBeenCalledWith({
      applicationId: APP_ID,
      recipient: 'owner@example.com',
      company: 'Acme',
    });
    expect(applications.update).toHaveBeenCalledWith(APP_ID, { nudgedAt: expect.any(Date) });
  });

  it('rejects a caller without the shared secret', async () => {
    const { controller, client } = buildController({ application: { id: APP_ID } });

    await expect(
      controller.outcomeNudge('wrong', { context: { applicationId: APP_ID } } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('does not nudge twice about one application', async () => {
    const application = { id: APP_ID, state: 'downloaded', nudgedAt: new Date(), outcome: null };
    const { controller, client } = buildController({ application });

    await controller.outcomeNudge('shhh', { context: { applicationId: APP_ID } } as any);

    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('does not nudge an application whose outcome is already recorded', async () => {
    const application = {
      id: APP_ID,
      state: 'marked_sent',
      nudgedAt: null,
      outcome: 'interview',
    };
    const { controller, client } = buildController({ application });

    await controller.outcomeNudge('shhh', { context: { applicationId: APP_ID } } as any);

    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('raises when the callback payload is missing or malformed', async () => {
    const { controller, client } = buildController({ application: null });

    await expect(controller.outcomeNudge('shhh', null as any)).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.outcomeNudge('shhh', undefined as any)).rejects.toThrow(
      BadRequestException,
    );
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
      controller.outcomeNudge('shhh', { context: { applicationId: MISSING_ID } } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('leaves nudgedAt unset when the send fails, so a retry can still deliver it', async () => {
    const application = {
      id: APP_ID,
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
      controller.outcomeNudge('shhh', { context: { applicationId: APP_ID } } as any),
    ).rejects.toThrow(/notifications down/);
    expect(applications.update).not.toHaveBeenCalled();
  });
});

describe('malformed applicationId', () => {
  it('rejects an applicationId that is not a uuid as a bad request, not a 500', async () => {
    const { controller, client } = buildController({ application: null });

    // The column is `uuid`, so a non-uuid reaches Postgres as a cast error and surfaces as a
    // 500 — an unhelpful "Internal server error" for what is plainly a malformed callback.
    await expect(
      controller.outcomeNudge('shhh', { context: { applicationId: 'not-a-uuid' } } as any),
    ).rejects.toThrow(BadRequestException);
    expect(client.sendOutcomeNudge).not.toHaveBeenCalled();
  });

  it('names the offending value so a misconfigured workflow is diagnosable', async () => {
    const { controller } = buildController({ application: null });

    await expect(
      controller.outcomeNudge('shhh', { context: { applicationId: 'not-a-uuid' } } as any),
    ).rejects.toThrow(/not-a-uuid/);
  });
});
