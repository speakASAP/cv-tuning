import { Logger } from '@nestjs/common';

/**
 * A model asked for JSON returns it fenced about as often as it returns it bare, and neither
 * form is an error. Six services parsed that themselves before this helper existed, each with
 * its own copy of the same regex — a divergence waiting to happen, since a fix to one copy
 * silently leaves the other five wrong.
 */
const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/** Strips a ```json fence if one is present. A bare body is returned unchanged. */
export function unfence(text: string): string {
  return FENCE.exec(text)?.[1] ?? text;
}

/**
 * Parses a model completion into JSON, raising with the offending body on failure.
 *
 * Raises rather than returning null on purpose: an unparseable completion means the model did
 * not do what was asked, and every caller's next step would be to fail anyway. Returning an
 * empty result here would present "the model returned garbage" as "the model found nothing",
 * which are different outcomes that must stay distinguishable.
 *
 * `label` names the operation in both the log line and the thrown message, so a parse failure
 * points at which of the six call sites produced it.
 */
export function parseJsonCompletion(text: string, label: string, logger: Logger): unknown {
  try {
    return JSON.parse(unfence(text));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error(`failed to parse ${label} response: ${message}; body=${text.slice(0, 300)}`);
    throw new Error(`could not parse ${label} response: ${message}`);
  }
}

/**
 * Pulls a required array field out of a parsed completion.
 *
 * A missing or non-array field raises rather than defaulting to `[]`: "the model returned no
 * paragraphs" and "the model returned a shape we do not understand" would otherwise be
 * indistinguishable to the caller, and the second is a bug while the first is a valid outcome.
 */
export function requireArray(parsed: unknown, field: string, label: string): unknown[] {
  const value = (parsed as Record<string, unknown> | null)?.[field];
  if (!Array.isArray(value)) {
    throw new Error(`${label} response has no ${field} array`);
  }
  return value;
}
