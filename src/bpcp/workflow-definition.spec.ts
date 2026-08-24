import { readFileSync } from 'fs';
import { join } from 'path';
import { OUTCOME_WORKFLOW_ID, OUTCOME_WORKFLOW_VERSION } from './bpcp-client.service';

const definition = JSON.parse(
  readFileSync(
    join(__dirname, '../../docs/workflows/cv-application-outcome.workflow.json'),
    'utf8',
  ),
);

describe('cv-application-outcome workflow', () => {
  it('matches the id and version the client starts', () => {
    expect(definition.workflowId).toBe(OUTCOME_WORKFLOW_ID);
    expect(definition.version).toBe(OUTCOME_WORKFLOW_VERSION);
    expect(definition.schemaVersion).toBe('bpcp.workflow.v1');
  });

  it('waits one day for the sent signal and CONTINUES on timeout', () => {
    const wait = definition.actions.find((a: any) => a.type === 'wait-for-signal');
    expect(wait.parameters.signalName).toBe('sent');
    expect(wait.parameters.timeoutMs).toBe(86_400_000);
    // 'fail' would mark the instance failed and never dispatch the nudge action, which is the
    // entire point of the timer.
    expect(wait.parameters.onTimeout).toBe('continue');
  });

  it('dispatches the nudge action after the wait, not in parallel with it', () => {
    const wait = definition.actions.find((a: any) => a.type === 'wait-for-signal');
    const nudge = definition.actions.find((a: any) => a.actionId === 'send-outcome-nudge');
    expect(nudge.dependsOn).toContain(wait.actionId);
    expect(typeof nudge.parameters.url).toBe('string');
  });

  it('carries the callback secret as an env reference, never as a literal', () => {
    const nudge = definition.actions.find((a: any) => a.actionId === 'send-outcome-nudge');
    // The document is stored in BPCP, listed over its API, and committed to git. A literal
    // secret here would be a secret in three public-ish places at once; BPCP's dispatcher
    // resolves `${env:VAR}` from its own environment at send time instead.
    expect(nudge.parameters.headers['x-cv-nudge-secret']).toBe('${env:CV_NUDGE_CALLBACK_SECRET}');
    expect(JSON.stringify(definition)).not.toMatch(/secret"\s*:\s*"(?!\$\{env:)/);
  });
});
