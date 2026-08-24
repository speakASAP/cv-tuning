import { readFileSync } from 'fs';
import { join } from 'path';
import { NudgeController } from './nudge.controller';

const APP_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The dispatcher lives in another repo, so this pins the CONTRACT between the two halves:
 * the workflow document names the header, BPCP resolves `${env:VAR}` into it, and this
 * controller reads that exact header name. A rename on either side silently disables every
 * nudge — the only symptom would be BPCP instances stuck at the callback.
 */
const definition = JSON.parse(
  readFileSync(
    join(__dirname, '../../docs/workflows/cv-application-outcome.workflow.json'),
    'utf8',
  ),
);

describe('nudge callback contract', () => {
  it('the workflow sends exactly the header the controller reads', () => {
    const nudge = definition.actions.find((a: any) => a.actionId === 'send-outcome-nudge');
    const headerNames = Object.keys(nudge.parameters.headers);

    // The controller's @Headers() name, read off the compiled source rather than duplicated
    // here as a literal, so this test cannot pass against a renamed parameter.
    const controllerSource = readFileSync(join(__dirname, 'nudge.controller.ts'), 'utf8');
    for (const name of headerNames) {
      expect(controllerSource).toContain(`@Headers('${name}')`);
    }
    expect(headerNames).toContain('x-cv-nudge-secret');
  });

  it('the workflow posts to the controller route this service actually exposes', () => {
    const nudge = definition.actions.find((a: any) => a.actionId === 'send-outcome-nudge');
    const controllerSource = readFileSync(join(__dirname, 'nudge.controller.ts'), 'utf8');
    const { pathname } = new URL(nudge.parameters.url);

    expect(pathname).toBe('/api/nudges/outcome');
    expect(controllerSource).toContain("@Controller('api/nudges')");
    expect(controllerSource).toContain("@Post('outcome')");
  });

  it('the callback body BPCP posts carries the applicationId where the controller looks for it', async () => {
    const application = {
      id: APP_ID,
      state: 'downloaded',
      nudgedAt: null,
      outcome: null,
      jobId: null,
    };
    const send = jest.fn(async () => undefined);
    const controller = new NudgeController(
      { findOne: jest.fn(async () => application), update: jest.fn() } as any,
      { findOne: jest.fn(async () => null) } as any,
      { sendOutcomeNudge: send } as any,
      'shhh',
      'owner@example.com',
    );

    // The exact envelope shape BPCP's ActionDispatcherService serialises:
    // `{actionId, parameters, context}`, with the instance context carrying applicationId.
    const bpcpEnvelope = {
      actionId: 'send-outcome-nudge',
      parameters: { url: 'http://cv-tuning:3379/api/nudges/outcome' },
      context: { applicationId: APP_ID, userId: 'user-1' },
    };

    await controller.outcomeNudge('shhh', bpcpEnvelope);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: APP_ID, company: null }),
    );
  });
});
