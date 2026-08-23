import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { CvAuthGuard } from './cv-auth.guard';

const contextWith = (headers: Record<string, string>) => {
  const request: Record<string, unknown> = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    __request: request,
  } as never;
};

const requestOf = (ctx: unknown): Record<string, unknown> =>
  (ctx as { __request: Record<string, unknown> }).__request;

describe('CvAuthGuard', () => {
  let fetchMock: jest.Mock;
  let guard: CvAuthGuard;

  beforeEach(() => {
    fetchMock = jest.fn();
    guard = new CvAuthGuard('http://auth-microservice:3370', fetchMock as unknown as typeof fetch);
  });

  it('rejects a request with no Authorization header', async () => {
    await expect(guard.canActivate(contextWith({}))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer Authorization header', async () => {
    await expect(guard.canActivate(contextWith({ authorization: 'Basic abc' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an invalid token', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'nope' });

    await expect(guard.canActivate(contextWith({ authorization: 'Bearer bad' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token the service reports as not valid', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ valid: false }) });

    await expect(guard.canActivate(contextWith({ authorization: 'Bearer bad' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches the user on a valid token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, user: { id: 'u1', email: 'a@b.c' } }),
    });
    const ctx = contextWith({ authorization: 'Bearer good' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(requestOf(ctx).user).toEqual({ id: 'u1', email: 'a@b.c' });
  });

  it('raises 503, not 401, when auth is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    // An outage is not a bad credential. Collapsing the two hides the outage and
    // tells the user their login is wrong when the service is simply down.
    await expect(guard.canActivate(contextWith({ authorization: 'Bearer good' }))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('raises 503 when auth returns a server error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });

    await expect(guard.canActivate(contextWith({ authorization: 'Bearer good' }))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('raises 503 when the response body is not parseable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });

    await expect(guard.canActivate(contextWith({ authorization: 'Bearer good' }))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('names auth-microservice in the outage error so the cause is obvious', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(guard.canActivate(contextWith({ authorization: 'Bearer good' }))).rejects.toThrow(
      /auth-microservice/,
    );
  });

  it('rejects a valid response that carries no user', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ valid: true }) });

    await expect(guard.canActivate(contextWith({ authorization: 'Bearer good' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
