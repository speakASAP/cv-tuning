import { ConsentGuard } from './consent.guard';
import { CV_CONSENT_VERSION } from './consent.service';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

describe('ConsentGuard', () => {
  const contextFor = (user: unknown) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as never;

  it('allows a request from a user holding current consent', async () => {
    const consent = { hasCurrentConsent: jest.fn(async () => true) };
    const guard = new ConsentGuard(consent as never);
    await expect(guard.canActivate(contextFor({ id: 'u1', email: 'a@b.c' }))).resolves.toBe(true);
    expect(consent.hasCurrentConsent).toHaveBeenCalledWith('u1');
  });

  it('forbids a request from a user without current consent', async () => {
    const consent = { hasCurrentConsent: jest.fn(async () => false) };
    const guard = new ConsentGuard(consent as never);
    await expect(guard.canActivate(contextFor({ id: 'u1', email: 'a@b.c' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('names the notice version the user must consent to', async () => {
    const consent = { hasCurrentConsent: jest.fn(async () => false) };
    const guard = new ConsentGuard(consent as never);
    await expect(guard.canActivate(contextFor({ id: 'u1' }))).rejects.toThrow(CV_CONSENT_VERSION);
  });

  it('fails closed when the request carries no authenticated user', async () => {
    const consent = { hasCurrentConsent: jest.fn(async () => true) };
    const guard = new ConsentGuard(consent as never);
    await expect(guard.canActivate(contextFor(undefined))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(consent.hasCurrentConsent).not.toHaveBeenCalled();
  });
});
