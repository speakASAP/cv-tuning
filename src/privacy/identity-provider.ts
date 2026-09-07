import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export const IDENTITY_PROVIDER = 'CV_IDENTITY_PROVIDER';
export const AUTH_USER_LOOKUP_URL = 'CV_AUTH_USER_LOOKUP_URL';
export const IDP_FETCH = 'CV_IDP_FETCH';
/**
 * Per-pair Auth-issued RS256 credential for `svc-cv-tuning--auth-microservice`,
 * holding `internal:auth-microservice:user-existence`.
 */
export const AUTH_USER_LOOKUP_BEARER = 'CV_AUTH_USER_LOOKUP_BEARER';

const LOOKUP_TIMEOUT_MS = 3000;

/**
 * The seam for offboarding reconciliation (spec §3.2).
 *
 * auth-microservice's protected `GET /internal/users/:userId/existence` endpoint is the
 * authoritative account-existence capability. This port keeps the reconciliation policy explicit:
 * a missing configuration remains unavailable, and an unavailable or ambiguous provider response
 * never becomes evidence that an account is gone.
 */
export interface IdentityProviderPort {
  /** Whether a real lookup capability is configured. When false, reconciliation must not purge. */
  readonly available: boolean;

  /**
   * Whether the auth account still exists.
   *  - `true`  : the account is live.
   *  - `false` : the identity provider CONFIRMED the account is gone.
   *  - `null`  : the provider could not answer (unavailable, transport error, ambiguous status).
   *              Never treated as "gone", so an outage can never by itself trigger a deletion.
   */
  userExists(userId: string): Promise<boolean | null>;
}

/**
 * Default provider. Reads OPTIONAL `AUTH_USER_LOOKUP_URL` + Auth Bearer
 * `AUTH_USER_LOOKUP_BEARER`. When either is unset it is unavailable and every lookup
 * returns `null`, so the offboarding job stays safely blocked. A configured GET of
 * `${lookupUrl}/${userId}` is read as: 200 → exists, 404 → confirmed gone, anything else → `null`.
 */
@Injectable()
export class HttpIdentityProvider implements IdentityProviderPort {
  private readonly logger = new Logger(HttpIdentityProvider.name);

  constructor(
    @Optional() @Inject(AUTH_USER_LOOKUP_URL) private readonly lookupUrl: string | null = null,
    @Optional() @Inject(AUTH_USER_LOOKUP_BEARER) private readonly lookupBearer: string | null = null,
    @Optional() @Inject(IDP_FETCH) private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get available(): boolean {
    return !!this.lookupUrl && !!this.lookupBearer;
  }

  async userExists(userId: string): Promise<boolean | null> {
    if (!this.lookupUrl || !this.lookupBearer) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    const bearer = this.lookupBearer.trim().replace(/^Bearer\s+/i, '');
    if (!bearer) {
      this.logger.error('identity-provider AUTH_USER_LOOKUP_BEARER is empty; treating lookup as unresolved');
      return null;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.lookupUrl}/${encodeURIComponent(userId)}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${bearer}`,
        },
        signal: controller.signal,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // Unreachable is NOT "gone": returning null keeps a live user's data safe during an outage.
      this.logger.error(`identity-provider lookup for ${userId} failed: ${message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 200) return true;
    if (response.status === 404) return false;

    this.logger.error(`identity-provider lookup for ${userId} returned ${response.status}; treating as unresolved`);
    return null;
  }
}
