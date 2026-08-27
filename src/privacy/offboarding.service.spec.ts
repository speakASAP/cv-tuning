import { OffboardingService } from './offboarding.service';
import { IdentityProviderPort } from './identity-provider';

describe('OffboardingService', () => {
  const setup = (idp: IdentityProviderPort, profileRows: unknown[] = []) => {
    const profiles = { find: jest.fn(async () => profileRows) };
    const deletion = { deleteAccount: jest.fn(async () => ({ userId: 'x' })) };
    const service = new OffboardingService(profiles as never, idp, deletion as never);
    return { service, profiles, deletion };
  };

  it('is blocked, and deletes nothing, when no identity-provider lookup is configured', async () => {
    const idp: IdentityProviderPort = { available: false, userExists: jest.fn(async () => null) };
    const { service, deletion } = setup(idp, [{ userId: 'u1' }]);
    const report = await service.reconcile();
    expect(report.status).toBe('blocked');
    expect(report.reason).toContain('AUTH_USER_LOOKUP_URL');
    expect(report.purged).toBe(0);
    expect(deletion.deleteAccount).not.toHaveBeenCalled();
  });

  it('purges only accounts the provider CONFIRMS are gone', async () => {
    const idp: IdentityProviderPort = {
      available: true,
      userExists: jest.fn(async (id: string) => (id === 'gone' ? false : true)),
    };
    const { service, deletion } = setup(idp, [{ userId: 'gone' }, { userId: 'live' }]);
    const report = await service.reconcile();
    expect(report.status).toBe('ok');
    expect(report.checked).toBe(2);
    expect(report.purged).toBe(1);
    expect(report.purgedUserIds).toEqual(['gone']);
    expect(deletion.deleteAccount).toHaveBeenCalledTimes(1);
    expect(deletion.deleteAccount).toHaveBeenCalledWith('gone');
  });

  it('never deletes on an unresolved (null) lookup', async () => {
    const idp: IdentityProviderPort = { available: true, userExists: jest.fn(async () => null) };
    const { service, deletion } = setup(idp, [{ userId: 'u1' }, { userId: 'u2' }]);
    const report = await service.reconcile();
    expect(report.status).toBe('ok');
    expect(report.purged).toBe(0);
    expect(report.unresolved).toBe(2);
    expect(deletion.deleteAccount).not.toHaveBeenCalled();
  });
});
