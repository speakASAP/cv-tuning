import { JobFetcherService } from './job-fetcher.service';

const html = (body: string) => `<html><head><title>Job</title></head><body>${body}</body></html>`;
const longPosting = html(`<p>${'We need a senior engineer with strong TypeScript and PostgreSQL skills. '.repeat(12)}</p>`);

describe('JobFetcherService', () => {
  let fetchMock: jest.Mock;
  let fetcher: JobFetcherService;

  beforeEach(() => {
    fetchMock = jest.fn();
    fetcher = new JobFetcherService(fetchMock as unknown as typeof fetch, async () => '93.184.216.34');
  });

  const ok = (body: string) => ({ ok: true, status: 200, url: 'https://jobs.example.com/1', text: async () => body });

  it('returns ok with reduced text for a normal posting', async () => {
    fetchMock.mockResolvedValue(ok(longPosting));

    const result = await fetcher.fetch('https://jobs.example.com/1');

    expect(result.status).toBe('ok');
    expect(result.text).toContain('senior engineer');
    expect(result.text).not.toContain('<p>');
  });

  it('strips script and style content before measuring length', async () => {
    const withNoise = html(
      `<script>${'x'.repeat(5000)}</script><style>${'y'.repeat(5000)}</style><p>Short.</p>`,
    );
    fetchMock.mockResolvedValue(ok(withNoise));

    const result = await fetcher.fetch('https://jobs.example.com/1');

    // Without stripping, the padding would make this look like a full posting.
    expect(result.status).toBe('thin');
    expect(result.text).not.toContain('xxxx');
  });

  it('classifies 403 as blocked, not failed', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, url: 'https://x', text: async () => 'denied' });

    const result = await fetcher.fetch('https://jobs.example.com/1');

    // Blocked is actionable: the user can paste. Failed is not.
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/403/);
  });

  it('classifies 401 as blocked', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, url: 'https://x', text: async () => '' });

    expect((await fetcher.fetch('https://jobs.example.com/1')).status).toBe('blocked');
  });

  it('classifies 429 as blocked', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, url: 'https://x', text: async () => '' });

    expect((await fetcher.fetch('https://jobs.example.com/1')).status).toBe('blocked');
  });

  it('classifies a 500 as failed', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, url: 'https://x', text: async () => 'boom' });

    expect((await fetcher.fetch('https://jobs.example.com/1')).status).toBe('failed');
  });

  it('classifies a transport error as failed', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const result = await fetcher.fetch('https://jobs.example.com/1');

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/ECONNRESET/);
  });

  it('classifies a page with almost no text as thin', async () => {
    fetchMock.mockResolvedValue(ok(html('<div id="root"></div>')));

    // A JS-rendered shell, not a real posting.
    expect((await fetcher.fetch('https://jobs.example.com/1')).status).toBe('thin');
  });

  it('never returns ok with empty text', async () => {
    fetchMock.mockResolvedValue(ok(html('')));

    const result = await fetcher.fetch('https://jobs.example.com/1');

    expect(result.status).not.toBe('ok');
    expect(result.text).toBe('');
  });

  it('rejects a non-http URL scheme', async () => {
    const result = await fetcher.fetch('file:///etc/passwd');

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/scheme/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a URL resolving to a loopback address', async () => {
    const guarded = new JobFetcherService(fetchMock as unknown as typeof fetch, async () => '127.0.0.1');

    const result = await guarded.fetch('https://localhost-alias.example.com/1');

    // This endpoint fetches user-supplied URLs from inside the cluster.
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/private|loopback/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a URL resolving to a private range', async () => {
    const guarded = new JobFetcherService(fetchMock as unknown as typeof fetch, async () => '10.42.0.15');

    expect((await guarded.fetch('https://internal.example.com/1')).status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when a redirect lands on a private address', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'http://169.254.169.254/latest/meta-data/',
      text: async () => longPosting,
    });

    const result = await fetcher.fetch('https://jobs.example.com/1');

    // Link-shortener to cloud metadata is the classic SSRF path.
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/private|redirect/i);
  });
});
