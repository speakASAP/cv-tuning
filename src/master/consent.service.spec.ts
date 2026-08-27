import { ConsentService, CV_CONSENT_VERSION } from './consent.service';

describe('ConsentService', () => {
  const make = (existing: any = null) => {
    const profiles = {
      findOne: jest.fn(async () => existing),
      create: jest.fn((value: unknown) => value),
      save: jest.fn(async (value: unknown) => value),
    };
    return { service: new ConsentService(profiles as never), profiles };
  };

  it('records the current notice version and timestamp', async () => {
    const { service } = make();
    const result = await service.grant('u1');
    expect(result).toMatchObject({ userId: 'u1', consentVersion: CV_CONSENT_VERSION });
    expect(result.consentAt).toBeInstanceOf(Date);
  });

  it('does not change evidence when the same version is granted again', async () => {
    const at = new Date('2026-08-01T00:00:00.000Z');
    const profile = { userId: 'u1', consentVersion: CV_CONSENT_VERSION, consentAt: at };
    const { service } = make(profile);
    await expect(service.grant('u1')).resolves.toBe(profile);
    expect(profile.consentAt).toBe(at);
  });

  it('updates the version and timestamp when the notice changes', async () => {
    const at = new Date('2026-08-01T00:00:00.000Z');
    const profile = { userId: 'u1', consentVersion: 'old', consentAt: at };
    const { service } = make(profile);
    const result = await service.grant('u1', CV_CONSENT_VERSION);
    expect(result.consentVersion).toBe(CV_CONSENT_VERSION);
    expect(result.consentAt).not.toBe(at);
  });

  describe('hasCurrentConsent', () => {
    it('is true only when the stored version matches the current notice', async () => {
      const { service } = make({ userId: 'u1', consentVersion: CV_CONSENT_VERSION });
      await expect(service.hasCurrentConsent('u1')).resolves.toBe(true);
    });

    it('is false for a stale consent version', async () => {
      const { service } = make({ userId: 'u1', consentVersion: 'old' });
      await expect(service.hasCurrentConsent('u1')).resolves.toBe(false);
    });

    it('is false when the user has no profile at all', async () => {
      const { service } = make(null);
      await expect(service.hasCurrentConsent('u1')).resolves.toBe(false);
    });
  });
});
