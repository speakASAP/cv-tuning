import {
  BpcpClientService,
  OUTCOME_WORKFLOW_ID,
  OUTCOME_WORKFLOW_VERSION,
} from './bpcp-client.service';

const okResponse = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

describe('startOutcomeWatch', () => {
  it('starts an instance correlated to the application', async () => {
    const fetchImpl = jest.fn(async () => okResponse({ instanceId: 'inst-9' }));
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    const instanceId = await service.startOutcomeWatch('app-1', 'user-1');

    expect(instanceId).toBe('inst-9');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bpcp:3375/api/instances');
    expect(JSON.parse(init.body as string)).toEqual({
      workflowId: OUTCOME_WORKFLOW_ID,
      workflowVersion: OUTCOME_WORKFLOW_VERSION,
      correlationKey: 'app-1',
      context: { applicationId: 'app-1', userId: 'user-1' },
    });
  });

  it('returns null when no BPCP url is configured, so a dev box runs without the workflow plane', async () => {
    const fetchImpl = jest.fn();
    const service = new BpcpClientService(fetchImpl as any, undefined);

    expect(await service.startOutcomeWatch('app-1', 'user-1')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('raises with status and body on a non-ok response rather than returning null', async () => {
    const fetchImpl = jest.fn(
      async () => ({ ok: false, status: 500, text: async () => 'boom' }) as Response,
    );
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    // "Not configured" and "the call failed" are different outcomes and must not collapse
    // into the same null.
    await expect(service.startOutcomeWatch('app-1', 'user-1')).rejects.toThrow(/500.*boom/s);
  });

  it('raises when the response carries no instanceId', async () => {
    const fetchImpl = jest.fn(async () => okResponse({}));
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    await expect(service.startOutcomeWatch('app-1', 'user-1')).rejects.toThrow(/instanceId/);
  });
});

describe('deliverSignal', () => {
  it('posts the signal to the instance', async () => {
    const fetchImpl = jest.fn(async () => okResponse({ status: 'completed' }));
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    await service.deliverSignal('inst-9', 'sent', { applicationId: 'app-1' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bpcp:3375/api/instances/inst-9/signals');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'sent',
      payload: { applicationId: 'app-1' },
    });
  });

  it('raises on a non-ok response, with the status and body in the message', async () => {
    const fetchImpl = jest.fn(
      async () => ({ ok: false, status: 404, text: async () => 'no such instance' }) as Response,
    );
    const service = new BpcpClientService(fetchImpl as any, 'http://bpcp:3375');

    await expect(service.deliverSignal('inst-9', 'sent', {})).rejects.toThrow(
      /404.*no such instance/s,
    );
  });
});
