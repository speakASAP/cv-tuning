import { ApplicationState, Outcome, OUTCOMES } from './application.types';

/**
 * Spec §5. `marked_sent` follows `downloaded` and nothing else.
 *
 * `approved` is deliberately excluded: an approved application has artifacts, but nothing
 * shows the user ever took them. Accepting a send from `approved` would let the funnel count
 * a submission that never had a file behind it.
 */
export const MARK_SENT_FROM: readonly ApplicationState[] = ['downloaded'];

export function assertCanMarkSent(state: ApplicationState): void {
  if (!MARK_SENT_FROM.includes(state)) {
    throw new Error(
      `cannot mark an application as sent from state "${state}"; expected one of ${MARK_SENT_FROM.join(', ')}`,
    );
  }
}

/**
 * Spec §5. An outcome is a reply to a submission, so it is only meaningful once the user has
 * asserted the submission happened. Recording an outcome from `downloaded` would silently
 * invent the missing `marked_sent` step and make every conversion rate on the dashboard wrong.
 */
export function assertCanRecordOutcome(
  state: ApplicationState,
  outcome: string,
): asserts outcome is Outcome {
  if (state !== 'marked_sent') {
    throw new Error(
      `cannot record an outcome from state "${state}"; the application must be marked_sent first`,
    );
  }
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(`unknown outcome "${outcome}"; expected one of ${OUTCOMES.join(', ')}`);
  }
}
