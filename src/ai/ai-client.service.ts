import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { pseudonymizePrompt } from './pseudonymize';

export const AI_FETCH = 'CV_AI_FETCH';
export const AI_SERVICE_URL = 'CV_AI_SERVICE_URL';
/** Auth-minted RS256 JWT for svc-cv-tuning--ai-microservice (Vault AI_SERVICE_TOKEN). */
export const AI_SERVICE_TOKEN = 'CV_AI_SERVICE_TOKEN';

export type AiTier = 'cheap' | 'smart';

export interface AiCompletionRequest {
  tier: AiTier;
  systemPrompt: string;
  userPrompt: string;
  /** Presence switches ai-microservice into JSON mode; also serialised into the prompt. */
  outputSchema?: Record<string, unknown>;
  maxTokens?: number;
  correlationId?: string;
  /** Budget for THIS service's HTTP call to ai-microservice. */
  timeoutMs?: number;
  /**
   * Budget ai-microservice should apply to its own upstream LiteLLM call. Always strictly
   * below `timeoutMs`, so the upstream deadline fires first and returns a structured
   * AI_HTTP_TIMEOUT rather than this client aborting and losing the error code.
   */
  upstreamTimeoutMs?: number;
}

export interface AiCompletion {
  text: string;
  /** The model that ACTUALLY served the request, not the tier that was asked for. */
  modelUsed: string;
  /** True when the served model is not one the requested tier should use. */
  degraded: boolean;
}

/**
 * Models each tier is allowed to be served by. Anything else means LiteLLM fell back,
 * and for prose generation a fallback is a silent quality collapse rather than a
 * transparent retry — the response still looks perfectly well-formed.
 */
const EXPECTED_MODELS: Record<AiTier, readonly string[]> = {
  cheap: ['openrouter/google/gemma-4-26b-a4b-it:free'],
  smart: ['openrouter/google/gemma-4-31b-it:free'],
};

/**
 * The binding constraint is NOT the LiteLLM proxy — it is Cloudflare. cv.alfares.cz is
 * proxied (`server: cloudflare`), and the free plan cuts an origin request off at ~100s with
 * its own 504 HTML page. Nothing this service sets can extend that, so a budget above it buys
 * only a response no browser is still waiting for: the user saw a Cloudflare error page while
 * this service was still working (2026-09-06).
 *
 * 95s therefore sits just under the edge limit, so OUR deadline fires first and the caller
 * gets a structured error instead of Cloudflare's HTML. The whole chain nests inside it:
 * 85s upstream (below) < 95s here < ~100s edge.
 *
 * The prior 150s predated the ingress being public and was chosen only to sit above the
 * proxy's request_timeout; the fallback-chain concern it documented is now enforced by
 * DEFAULT_UPSTREAM_TIMEOUT_MS nesting below this value, not by the value being large.
 */
const DEFAULT_TIMEOUT_MS = 95_000;

/**
 * Budget ai-microservice is asked to apply to its own upstream LiteLLM call.
 *
 * Its deployed global is 75s, which a grounding eval measured this service's prompts running
 * right up against: median 40.3s, max 70.3s, against a 58+10+5=73s LiteLLM chain — about 3s
 * of headroom, so a slow call tips over and the user sees a dead revise. That global is
 * pinned from above and cannot be raised for everyone (education-service allows 180s and
 * retries once, so 2x the global is its ceiling), so this service asks for its own budget
 * instead of moving a shared one.
 *
 * Every call on this client's path is a long CV prompt, so it applies to all of them rather
 * than to a list of callers a sixth caller would be forgotten from. It stays strictly below
 * DEFAULT_TIMEOUT_MS so the upstream deadline fires FIRST and comes back as a structured
 * AI_HTTP_TIMEOUT; if this client aborted first, the error code would be lost and the caller
 * could not tell a timeout from an unreachable service.
 *
 * 85s clears the 70.3s worst case measured for these prompts, and is bounded above by
 * Cloudflare's ~100s edge limit rather than by anything in this stack — see
 * DEFAULT_TIMEOUT_MS. It also requires LiteLLM's own smart chain (58+10+5=73s) to stay
 * below it, which it does.
 */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 85_000;

@Injectable()
export class AiClientService {
  static readonly ALLOWED_TIERS: readonly AiTier[] = ['cheap', 'smart'];

  private readonly logger = new Logger(AiClientService.name);

  constructor(
    @Optional() @Inject(AI_SERVICE_URL) private readonly aiServiceUrl: string = process.env.AI_SERVICE_URL ?? '',
    @Optional() @Inject(AI_SERVICE_TOKEN) private readonly aiServiceToken: string = process.env.AI_SERVICE_TOKEN ?? '',
    @Optional() @Inject(AI_FETCH) private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(input: AiCompletionRequest): Promise<AiCompletion> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const promptBytes = Buffer.byteLength(`${input.systemPrompt}\n${input.userPrompt}`, 'utf8');
    this.logger.log(
      `${new Date().toISOString()} ai complete start tier=${input.tier} prompt_bytes=${promptBytes} ` +
        `timeout_ms=${timeoutMs} correlation=${input.correlationId ?? 'none'}`,
    );
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const bearer = this.requireServiceToken();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.aiServiceUrl}/ai/complete`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model_tier: input.tier,
          system_prompt: pseudonymizePrompt(input.systemPrompt),
          user_prompt: pseudonymizePrompt(this.withSchema(input.userPrompt, input.outputSchema)),
          output_schema: input.outputSchema,
          max_tokens: input.maxTokens ?? 8000,
          correlation_id: input.correlationId,
          // The budget ai-microservice should apply to its own upstream LiteLLM call. Without
          // it that call aborts at the global LITELLM_TIMEOUT_MS (75s in the deployed
          // configmap), which is below what this service's CV prompts measurably need, so a
          // revise died upstream long before the timeout above was reached. Always sent:
          // every call on this path is a long CV prompt (see DEFAULT_UPSTREAM_TIMEOUT_MS).
          timeout_ms: input.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
        }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(
        `${new Date().toISOString()} ai-microservice unreachable at ${this.aiServiceUrl}/ai/complete ` +
          `after ${Date.now() - startedAt}ms: ${message}`,
      );
      throw new Error(`ai-microservice request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      this.logger.error(`ai-microservice returned ${response.status}: ${body.slice(0, 300)}`);
      throw new Error(`ai-microservice returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      text?: string;
      model_used?: string;
      tier_used?: string;
      model_resolved?: boolean;
      served_by_fallback?: boolean;
      error_code?: string;
      error_message?: string;
    };

    if (payload.error_code) {
      this.logger.error(
        `${new Date().toISOString()} ai-microservice error ${payload.error_code} ` +
          `after ${Date.now() - startedAt}ms: ${(payload.error_message ?? '').slice(0, 300)}`,
      );
      throw new Error(`ai-microservice error ${payload.error_code}: ${(payload.error_message ?? '').slice(0, 300)}`);
    }

    const text = payload.text ?? '';
    if (text.trim().length === 0) {
      // An empty completion is a failure, never a result. Returning it would let a blank
      // CV section look like a deliberately blank section.
      this.logger.error(`ai-microservice returned empty text for tier=${input.tier}`);
      throw new Error(`ai-microservice returned an empty completion for tier ${input.tier}`);
    }

    const modelUsed = payload.model_used ?? 'unknown';

    // model_resolved === false means ai-microservice never learned a real model id and
    // model_used is standing in with the tier name. That is not a served model, so it can
    // never satisfy the expected-model check — treat it as degraded outright rather than
    // string-matching a tier against the model list (spec 8.1).
    const modelResolved = payload.model_resolved !== false;
    const servedByFallback = payload.served_by_fallback === true;
    const degraded = !modelResolved || servedByFallback || !EXPECTED_MODELS[input.tier].includes(modelUsed);

    if (!modelResolved) {
      this.logger.error(
        `ai-microservice reported model_resolved=false for tier ${input.tier} ` +
          `(model_used=${modelUsed}, tier_used=${payload.tier_used ?? 'absent'}); ` +
          'the upstream model id is unknown, so the completion is degraded',
      );
    } else if (servedByFallback) {
      // LiteLLM echoes the tier alias whether the tier's own model or its fallback served
      // the call, so this flag is the only way the switch is visible here. A fallback
      // returns well-formed prose from a different model — a silent quality change.
      this.logger.error(
        `tier ${input.tier} was served by a LiteLLM FALLBACK (${modelUsed}); marking the result degraded`,
      );
    } else if (degraded) {
      this.logger.error(
        `tier ${input.tier} was served by ${modelUsed}, not an expected model; marking the result degraded`,
      );
    }

    this.logger.log(
      `${new Date().toISOString()} ai complete done tier=${input.tier} model=${modelUsed} ` +
        `duration_ms=${Date.now() - startedAt} degraded=${degraded}`,
    );
    return { text, modelUsed, degraded };
  }

  /**
   * The schema object never reaches the provider upstream — its presence only flips JSON
   * mode on — so it has to be serialised into the prompt or the model never learns the
   * field names it must produce.
   */
  private withSchema(prompt: string, schema?: Record<string, unknown>): string {
    if (!schema) return prompt;
    return `${prompt}\n\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}`;
  }

  private requireServiceToken(): string {
    const token = this.aiServiceToken.trim().replace(/^Bearer\s+/i, '');
    if (!token) {
      throw new Error('AI_SERVICE_TOKEN is not set; cannot authenticate to ai-microservice');
    }
    return token;
  }
}
