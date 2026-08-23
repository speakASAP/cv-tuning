import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { FetchStatus } from './job.types';

export const JOB_FETCH = 'CV_JOB_FETCH';
export const DNS_RESOLVE = 'CV_DNS_RESOLVE';

export interface FetchResult {
  status: FetchStatus;
  text: string;
  reason?: string;
}

export type DnsResolver = (hostname: string) => Promise<string>;

/** Below this, the page is a JS shell or an error page rather than a real posting. */
const MIN_POSTING_CHARS = 400;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;

const STRIPPED_BLOCKS = /<(script|style|noscript|svg|nav|footer|header|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * This service fetches a URL the user supplies, from inside the cluster, so it is a
 * textbook SSRF sink: without these checks a posting URL could reach the Kubernetes API,
 * cloud metadata at 169.254.169.254, or any internal service.
 */
function isPrivateAddress(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;

  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a >= 224
  );
}

@Injectable()
export class JobFetcherService {
  private readonly logger = new Logger(JobFetcherService.name);

  constructor(
    @Optional() @Inject(JOB_FETCH) private readonly fetchImpl: typeof fetch = fetch,
    @Optional()
    @Inject(DNS_RESOLVE)
    private readonly resolve: DnsResolver = async (hostname) => (await lookup(hostname)).address,
  ) {}

  async fetch(rawUrl: string): Promise<FetchResult> {
    const guard = await this.guardUrl(rawUrl);
    if (guard) return guard;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(rawUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`job fetch failed for ${rawUrl}: ${reason}`);
      return { status: 'failed', text: '', reason };
    } finally {
      clearTimeout(timeout);
    }

    // Re-check after redirects: the guard above only covered the URL the user gave us.
    const landed = await this.guardUrl(response.url || rawUrl, 'redirect');
    if (landed) return landed;

    if (!response.ok) {
      const blocked = response.status === 401 || response.status === 403 || response.status === 429;
      const reason = `HTTP ${response.status}`;
      this.logger.warn(`job fetch ${blocked ? 'blocked' : 'failed'} for ${rawUrl}: ${reason}`);
      return { status: blocked ? 'blocked' : 'failed', text: '', reason };
    }

    const body = (await response.text()).slice(0, MAX_BYTES);
    const text = this.toText(body);

    if (text.length < MIN_POSTING_CHARS) {
      // Distinct from blocked: the server answered, there just is no posting text here.
      return {
        status: 'thin',
        text,
        reason: `only ${text.length} characters of text found; the page is probably rendered by JavaScript`,
      };
    }

    return { status: 'ok', text };
  }

  private async guardUrl(rawUrl: string, phase = 'request'): Promise<FetchResult | null> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { status: 'failed', text: '', reason: `not a valid URL: ${rawUrl}` };
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { status: 'failed', text: '', reason: `unsupported URL scheme ${url.protocol}` };
    }

    // An IP-literal host never goes through DNS, so resolving it would consult the
    // injected resolver and wave the address straight through.
    const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(':');
    if (literal) {
      const bare = url.hostname.replace(/^\[|\]$/g, '');
      if (isPrivateAddress(bare)) {
        this.logger.error(`refusing ${phase} to private address literal ${bare}`);
        return { status: 'failed', text: '', reason: `${bare} is a private or loopback address (${phase})` };
      }
      return null;
    }

    let address: string;
    try {
      address = await this.resolve(url.hostname);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return { status: 'failed', text: '', reason: `could not resolve ${url.hostname}: ${reason}` };
    }

    if (isPrivateAddress(address)) {
      this.logger.error(`refusing ${phase} to ${url.hostname} which resolves to private address ${address}`);
      return {
        status: 'failed',
        text: '',
        reason: `${url.hostname} resolves to a private or loopback address (${phase})`,
      };
    }

    return null;
  }

  private toText(html: string): string {
    return html
      .replace(STRIPPED_BLOCKS, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
