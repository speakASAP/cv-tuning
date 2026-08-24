import { NotificationClientService } from './notification-client.service';

const ok = () => ({ ok: true, status: 200, text: async () => '{}' }) as Response;

describe('sendOutcomeNudge', () => {
  it('posts a custom transactional notification naming the company', async () => {
    const fetchImpl = jest.fn(async () => ok());
    const service = new NotificationClientService(
      fetchImpl as any,
      'http://notifications:3368',
      'svc-token',
    );

    await service.sendOutcomeNudge({
      applicationId: 'app-1',
      recipient: 'me@example.com',
      company: 'Acme',
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer svc-token');
    expect(url).toBe('http://notifications:3368/notifications/send');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('custom');
    expect(body.recipient).toBe('me@example.com');
    expect(body.purpose).toBe('transactional');
    expect(body.service).toBe('cv-tuning');
    expect(body.message).toContain('Acme');
    // notifications-microservice's channel-registry requires an explicit channel whenever
    // channelKey is omitted; without it the send fails with SEND_FAILED, not a validation error.
    expect(body.channel).toBe('email');
  });

  it('omits the company rather than printing a placeholder when it is unknown', async () => {
    const fetchImpl = jest.fn(async () => ok());
    const service = new NotificationClientService(
      fetchImpl as any,
      'http://notifications:3368',
      'svc-token',
    );

    await service.sendOutcomeNudge({
      applicationId: 'app-1',
      recipient: 'me@example.com',
      company: null,
    });

    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.message).not.toMatch(/null|undefined/);
    expect(body.message).toContain('your application');
  });

  it('raises with status and body on failure so a dropped nudge is never silent', async () => {
    const fetchImpl = jest.fn(
      async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }) as Response,
    );
    const service = new NotificationClientService(
      fetchImpl as any,
      'http://notifications:3368',
      'svc-token',
    );

    await expect(
      service.sendOutcomeNudge({
        applicationId: 'app-1',
        recipient: 'me@example.com',
        company: 'Acme',
      }),
    ).rejects.toThrow(/502.*bad gateway/s);
  });

  it('raises when no notifications url is configured, because a nudge was genuinely requested', async () => {
    const service = new NotificationClientService(jest.fn() as any, undefined, 'svc-token');

    await expect(
      service.sendOutcomeNudge({
        applicationId: 'app-1',
        recipient: 'me@example.com',
        company: null,
      }),
    ).rejects.toThrow(/CV_NOTIFICATIONS_SERVICE_URL/);
  });
});

describe('service authentication', () => {
  it('raises when no service token is configured, rather than being rejected as 401', async () => {
    const fetchImpl = jest.fn();
    const service = new NotificationClientService(
      fetchImpl as any,
      'http://notifications:3368',
      undefined,
    );

    // notifications-microservice's JwtRolesGuard answers a tokenless call with a bare 401,
    // which reads as "cv-tuning is unauthorized" rather than "cv-tuning is misconfigured".
    // Failing here names the actual cause, and never spends a request to learn it.
    await expect(
      service.sendOutcomeNudge({
        applicationId: 'app-1',
        recipient: 'me@example.com',
        company: null,
      }),
    ).rejects.toThrow(/CV_NOTIFICATIONS_SERVICE_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts the token in the request body, only the Authorization header', async () => {
    const fetchImpl = jest.fn(async () => ok());
    const service = new NotificationClientService(
      fetchImpl as any,
      'http://notifications:3368',
      'svc-token',
    );

    await service.sendOutcomeNudge({
      applicationId: 'app-1',
      recipient: 'me@example.com',
      company: null,
    });

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body as string).not.toContain('svc-token');
  });
});
