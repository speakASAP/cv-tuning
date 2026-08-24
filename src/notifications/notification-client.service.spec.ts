import { NotificationClientService } from './notification-client.service';

const ok = () => ({ ok: true, status: 200, text: async () => '{}' }) as Response;

describe('sendOutcomeNudge', () => {
  it('posts a custom transactional notification naming the company', async () => {
    const fetchImpl = jest.fn(async () => ok());
    const service = new NotificationClientService(fetchImpl as any, 'http://notifications:3368');

    await service.sendOutcomeNudge({
      applicationId: 'app-1',
      recipient: 'me@example.com',
      company: 'Acme',
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://notifications:3368/notifications/send');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('custom');
    expect(body.recipient).toBe('me@example.com');
    expect(body.purpose).toBe('transactional');
    expect(body.service).toBe('cv-tuning');
    expect(body.message).toContain('Acme');
  });

  it('omits the company rather than printing a placeholder when it is unknown', async () => {
    const fetchImpl = jest.fn(async () => ok());
    const service = new NotificationClientService(fetchImpl as any, 'http://notifications:3368');

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
    const service = new NotificationClientService(fetchImpl as any, 'http://notifications:3368');

    await expect(
      service.sendOutcomeNudge({
        applicationId: 'app-1',
        recipient: 'me@example.com',
        company: 'Acme',
      }),
    ).rejects.toThrow(/502.*bad gateway/s);
  });

  it('raises when no notifications url is configured, because a nudge was genuinely requested', async () => {
    const service = new NotificationClientService(jest.fn() as any, undefined);

    await expect(
      service.sendOutcomeNudge({
        applicationId: 'app-1',
        recipient: 'me@example.com',
        company: null,
      }),
    ).rejects.toThrow(/CV_NOTIFICATIONS_SERVICE_URL/);
  });
});
