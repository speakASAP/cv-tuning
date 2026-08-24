import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export const BPCP_FETCH = 'CV_BPCP_FETCH';
export const BPCP_SERVICE_URL = 'CV_BPCP_SERVICE_URL';

/**
 * The workflow registered in `docs/workflows/cv-application-outcome.workflow.json`. Its single
 * `wait-for-signal` action carries `onTimeout: 'continue'`, so BPCP's minute-by-minute
 * `InstanceTimeoutService` sweep is what fires the nudge — cv-tuning owns no timer of its own.
 */
export const OUTCOME_WORKFLOW_ID = 'cv-application-outcome';
export const OUTCOME_WORKFLOW_VERSION = 1;

/** Well below the LiteLLM-facing budgets elsewhere: these are local control-plane calls. */
const TIMEOUT_MS = 10_000;

@Injectable()
export class BpcpClientService {
  private readonly logger = new Logger(BpcpClientService.name);

  constructor(
    @Optional() @Inject(BPCP_FETCH) private readonly fetchImpl: typeof fetch = fetch,
    @Optional() @Inject(BPCP_SERVICE_URL) private readonly baseUrl?: string,
  ) {}

  /**
   * Starts the outcome watch for one application. Returns the instance id, or `null` when no
   * BPCP url is configured — a local dev box without the workflow plane still runs the rest of
   * the product. That null is ONLY ever "not configured": a call that was attempted and failed
   * raises, because a silently-missing watch means a user is never nudged and nobody finds out.
   */
  async startOutcomeWatch(applicationId: string, userId: string): Promise<string | null> {
    if (!this.baseUrl) {
      this.logger.warn(
        `${BPCP_SERVICE_URL} is not set; application ${applicationId} gets no outcome watch and will never be nudged`,
      );
      return null;
    }

    const url = `${this.baseUrl}/api/instances`;
    const body = {
      workflowId: OUTCOME_WORKFLOW_ID,
      workflowVersion: OUTCOME_WORKFLOW_VERSION,
      correlationKey: applicationId,
      context: { applicationId, userId },
    };

    const response = await this.post(url, body);
    const payload = (await response.json()) as { instanceId?: string };
    if (!payload.instanceId) {
      throw new Error(
        `BPCP ${url} returned no instanceId for application ${applicationId}: ${JSON.stringify(payload)}`,
      );
    }

    this.logger.log(`started outcome watch ${payload.instanceId} for application ${applicationId}`);
    return payload.instanceId;
  }

  async deliverSignal(
    instanceId: string,
    name: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.baseUrl) {
      this.logger.warn(
        `${BPCP_SERVICE_URL} is not set; dropping signal "${name}" for ${instanceId}`,
      );
      return;
    }
    await this.post(`${this.baseUrl}/api/instances/${instanceId}/signals`, { name, payload });
    this.logger.log(`delivered signal "${name}" to instance ${instanceId}`);
  }

  private async post(url: string, body: unknown): Promise<Response> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      // Status AND body: a bare "request failed" cannot be diagnosed from a log line.
      throw new Error(`BPCP ${url} failed with ${response.status}: ${text}`);
    }
    return response;
  }
}
