import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export const IDENTITY_PROVIDER = 'CV_IDENTITY_PROVIDER';
export const AUTH_USER_LOOKUP_URL = 'CV_AUTH_USER_LOOKUP_URL';
export const IDP_FETCH = 'CV_IDP_FETCH';
export const AUTH_USER_LOOKUP_TOKEN = 'CV_AUTH_USER_LOOKUP_TOKEN';
export const AUTH_USER_LOOKUP_SERVICE_NAME = 'CV_AUTH_USER_LOOKUP_SERVICE_NAME';

const LOOKUP_TIMEOUT_MS = 3000;

/**
 * The seam for offboarding reconciliation (spec §3.2).
 *
 * auth-microservice emits no offboarding events (ECOSYSTEM_MAP.md:126) AND — as of this phase —
 * exposes no user-listing or user-existence API this service could poll. Reconciliation therefore
 * cannot be implemented against a real capability yet; inventing an auth endpoint would be
 * fabrication. This port is the documented, non-fabricated place that capability plugs into when
 * auth grows one. Until then the default implementation reports `available === false` and
 * reconciliation refuses to run rather than guessing.
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
 * Default provider. Reads an OPTIONAL `AUTH_USER_LOOKUP_URL`. When unset (the current reality,
 * since auth exposes no such endpoint) it is unavailable and every lookup returns `null`, so the
 * offboarding job stays safely blocked. When a real endpoint is later configured, a GET of
 * `${lookupUrl}/${userId}` is read as: 200 → exists, 404 → confirmed gone, anything else → `null`.
 */
@Injectable()
export class HttpIdentityProvider implements IdentityProviderPort {
  private readonly logger = new Logger(HttpIdentityProvider.name);

  constructor(
    @Optional() @Inject(AUTH_USER_LOOKUP_URL) private readonly lookupUrl: string | null = null,
    @Optional() @Inject(AUTH_USER_LOOKUP_TOKEN) private readonly lookupToken: string | null = null,
    @Optional() @Inject(AUTH_USER_LOOKUP_SERVICE_NAME) private readonly serviceName = 'cv-tuning',
    @Optional() @Inject(IDP_FETCH) private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get available(): boolean {
    return !!this.lookupUrl;
  }

  async userExists(userId: string): Promise<boolean | null> {
    if (!this.lookupUrl) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.lookupUrl}/${encodeURIComponent(userId)}`, {
        method: 'GET',
        headers: {
          ...(this.lookupToken ? { 'x-internal-service-token': this.lookupToken } : {}),
          'x-service-name': this.serviceName,
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
