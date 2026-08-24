import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export const NOTIFICATIONS_FETCH = 'CV_NOTIFICATIONS_FETCH';
export const NOTIFICATIONS_SERVICE_URL = 'CV_NOTIFICATIONS_SERVICE_URL';

const TIMEOUT_MS = 10_000;

export interface OutcomeNudgeInput {
  applicationId: string;
  recipient: string;
  /** The employer, when the job record carries one. Null prints as nothing, never as a placeholder. */
  company: string | null;
}

@Injectable()
export class NotificationClientService {
  private readonly logger = new Logger(NotificationClientService.name);

  constructor(
    @Optional() @Inject(NOTIFICATIONS_FETCH) private readonly fetchImpl: typeof fetch = fetch,
    @Optional() @Inject(NOTIFICATIONS_SERVICE_URL) private readonly baseUrl?: string,
  ) {}

  /**
   * Spec §5: "any response?" a day after download, to keep the outcome dataset alive.
   *
   * Unlike `BpcpClientService`, a missing base url RAISES here. There it means "this deployment
   * has no workflow plane", a valid configuration. Here the nudge is already due, so an unset
   * url means a notification the product promised is being dropped.
   */
  async sendOutcomeNudge(input: OutcomeNudgeInput): Promise<void> {
    if (!this.baseUrl) {
      throw new Error(
        `${NOTIFICATIONS_SERVICE_URL} is not set; cannot send the outcome nudge for application ${input.applicationId}`,
      );
    }

    const subject = input.company
      ? `Any response from ${input.company}?`
      : 'Any response to your application?';
    const message = input.company
      ? `You downloaded a tailored CV for ${input.company} yesterday. Did you send it, and have you heard back? Recording the outcome takes a second and makes the next tailoring better.`
      : `You downloaded a tailored CV for your application yesterday. Did you send it, and have you heard back? Recording the outcome takes a second and makes the next tailoring better.`;

    const url = `${this.baseUrl}/notifications/send`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'custom',
        recipient: input.recipient,
        subject,
        message,
        purpose: 'transactional',
        service: 'cv-tuning',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`notifications ${url} failed with ${response.status}: ${text}`);
    }

    this.logger.log(`sent outcome nudge for application ${input.applicationId}`);
  }
}
