import { HttpIdentityProvider } from './identity-provider';

describe('HttpIdentityProvider', () => {
  it('is unavailable and answers null when no lookup url is set', async () => {
    const fetchImpl = jest.fn();
    const idp = new HttpIdentityProvider(null, fetchImpl as never);
    expect(idp.available).toBe(false);
    await expect(idp.userExists('u1')).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads 200 as exists, 404 as confirmed gone', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 404 });
    const idp = new HttpIdentityProvider('http://auth/users', fetchImpl as never);
    expect(idp.available).toBe(true);
    await expect(idp.userExists('live')).resolves.toBe(true);
    await expect(idp.userExists('gone')).resolves.toBe(false);
  });

  it('treats a transport failure as unresolved, never as gone', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const idp = new HttpIdentityProvider('http://auth/users', fetchImpl as never);
    await expect(idp.userExists('u1')).resolves.toBeNull();
  });

  it('treats an unexpected status as unresolved', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 500, text: async () => 'boom' });
    const idp = new HttpIdentityProvider('http://auth/users', fetchImpl as never);
    await expect(idp.userExists('u1')).resolves.toBeNull();
  });
});
