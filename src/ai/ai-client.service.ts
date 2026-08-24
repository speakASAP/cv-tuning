import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHmac } from 'crypto';

export const AI_FETCH = 'CV_AI_FETCH';
export const AI_SERVICE_URL = 'CV_AI_SERVICE_URL';
export const AI_JWT_SECRET = 'CV_AI_JWT_SECRET';

export type AiTier = 'cheap' | 'smart';

export interface AiCompletionRequest {
  tier: AiTier;
  systemPrompt: string;
  userPrompt: string;
  /** Presence switches ai-microservice into JSON mode; also serialised into the prompt. */
  outputSchema?: Record<string, unknown>;
  maxTokens?: number;
  correlationId?: string;
  timeoutMs?: number;
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
 * ServiceAuthGuard on /ai/complete verifies HS256 against JWT_SECRET and requires `iss`
 * to be exactly "ai-microservice" (JwtUtil.verify), regardless of which service calls.
 */
const TOKEN_ISSUER = 'ai-microservice';
const SERVICE_ID = 'cv-tuning';
const TOKEN_TTL_SECONDS = 900;

/**
 * Above the LiteLLM proxy's own request_timeout (120s). A caller timeout shorter than the
 * proxy's means the fallback chain never runs and the aborted attempts leave no trace in
 * the proxy log — the incident documented in litellm_config.yaml router_settings.
 */
const DEFAULT_TIMEOUT_MS = 150_000;

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

@Injectable()
export class AiClientService {
  static readonly ALLOWED_TIERS: readonly AiTier[] = ['cheap', 'smart'];

  private readonly logger = new Logger(AiClientService.name);

  constructor(
    @Optional() @Inject(AI_SERVICE_URL) private readonly aiServiceUrl: string = process.env.AI_SERVICE_URL ?? '',
    @Optional() @Inject(AI_JWT_SECRET) private readonly jwtSecret: string = process.env.JWT_SECRET ?? '',
    @Optional() @Inject(AI_FETCH) private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(input: AiCompletionRequest): Promise<AiCompletion> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.aiServiceUrl}/ai/complete`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.mintServiceToken()}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model_tier: input.tier,
          system_prompt: input.systemPrompt,
          user_prompt: this.withSchema(input.userPrompt, input.outputSchema),
          output_schema: input.outputSchema,
          max_tokens: input.maxTokens ?? 8000,
          correlation_id: input.correlationId,
        }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`ai-microservice unreachable at ${this.aiServiceUrl}/ai/complete: ${message}`);
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
      this.logger.error(`ai-microservice error ${payload.error_code}: ${(payload.error_message ?? '').slice(0, 300)}`);
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

    this.logger.log(`ai complete tier=${input.tier} model=${modelUsed} in ${Date.now() - startedAt}ms`);
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

  private mintServiceToken(): string {
    if (!this.jwtSecret) {
      throw new Error('JWT_SECRET is not set; cannot authenticate to ai-microservice');
    }

    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = base64url(
      JSON.stringify({ serviceId: SERVICE_ID, iss: TOKEN_ISSUER, iat: now, exp: now + TOKEN_TTL_SECONDS }),
    );
    const signature = base64url(createHmac('sha256', this.jwtSecret).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${signature}`;
  }
}
