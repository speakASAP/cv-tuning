/**
 * BENCHMARK-ONLY AI CLIENT — never imported by production code, only by
 * `benchmark-run.ts` in this directory.
 *
 * `AiClientService` (`../../ai/ai-client.service.ts`) deliberately types `AiTier` as
 * `'cheap' | 'smart'` — `premium` is BLOCKED in production until this very Phase 8
 * benchmark produces evidence for or against lifting the block (STATE.json, spec §8.2,
 * CLAUDE.md "Only the free `cheap` and `smart` tiers are allowed"). Widening `AiTier` or
 * `AiClientService.complete()` to accept `'premium'` would let a production caller reach
 * it by a typo or a careless copy-paste; every existing and future caller would then need
 * to newly prove it never does. That is exactly the "weakening production" this file is
 * required to avoid.
 *
 * Instead this is a small, self-contained client scoped to `__evals__`, with its own
 * `BenchmarkTier` union that a production import can never see. It mirrors
 * `AiClientService.complete()`'s request shape, auth, pseudonymization, and degraded-model
 * detection closely enough that the three tiers are measured on a level playing field, but
 * it is a deliberate, documented duplication — not a shared abstraction — so a change to
 * the production client's auth or retry behaviour cannot silently change what Phase 8
 * measured. If `mintServiceToken`'s HMAC scheme in `ai-client.service.ts` ever changes,
 * update the copy below too.
 */
import { createHmac, createSign } from 'crypto';
import { pseudonymizePrompt } from '../../ai/pseudonymize';

export type BenchmarkTier = 'cheap' | 'smart' | 'premium';

export const BENCHMARK_TIERS: readonly BenchmarkTier[] = ['cheap', 'smart', 'premium'];

/**
 * Models each tier is expected to be served by. `cheap`/`smart` mirror the production
 * `EXPECTED_MODELS` table in `ai-client.service.ts` (kept in sync manually — that table is
 * not exported). `premium` has no fixed production entry yet (spec §8: `anthropic/claude-
 * sonnet-4-6`, "BLOCKED — last phase only"), so it is supplied at runtime via
 * `CV_BENCHMARK_PREMIUM_MODELS` rather than hardcoded here; hardcoding a model id for a
 * tier production has never served would be a guess, not a fact.
 */
const FREE_TIER_MODELS: Record<'cheap' | 'smart', readonly string[]> = {
  cheap: ['openrouter/google/gemma-4-26b-a4b-it:free'],
  smart: ['openrouter/google/gemma-4-31b-it:free'],
};

const TOKEN_ISSUER = 'ai-microservice';
const SERVICE_ID = 'cv-tuning';
const TOKEN_TTL_SECONDS = 900;

/** Same floor as `ai-client.service.ts`'s `DEFAULT_TIMEOUT_MS`, for the same reason: it
 * must stay above the LiteLLM proxy's own `request_timeout` (120s) or the fallback chain
 * never runs. */
const DEFAULT_TIMEOUT_MS = 150_000;

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface BenchmarkCompletionRequest {
  tier: BenchmarkTier;
  systemPrompt: string;
  userPrompt: string;
  outputSchema?: Record<string, unknown>;
  maxTokens?: number;
  correlationId?: string;
  timeoutMs?: number;
  humanApproval?: boolean;
}

export interface BenchmarkCompletion {
  text: string;
  modelUsed: string;
  degraded: boolean;
  /** Wall-clock time for this single completion call, for the per-tier latency comparison. */
  latencyMs: number;
  /**
   * Token/cost accounting, populated ONLY when ai-microservice's response body exposes
   * them. As of this writing `/ai/complete`'s documented response
   * (`ai-client.service.ts`'s `payload` type) carries none of these fields — they are
   * read defensively in case a future upstream version adds them, per the task's
   * instruction to record them "if the upstream response exposes them". `null` means
   * "not reported", never "zero".
   */
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

/** Thrown when `premium` is requested but no premium model list was configured. */
export class PremiumNotConfiguredError extends Error {
  constructor() {
    super(
      'premium tier requested but CV_BENCHMARK_PREMIUM_MODELS is not set; premium is BLOCKED ' +
        'in production (STATE.json) and this benchmark has no way to know what model or ' +
        'deployment id upstream would serve it with, so it is skipped rather than guessed',
    );
    this.name = 'PremiumNotConfiguredError';
  }
}

export interface BenchmarkAiClientOptions {
  aiServiceUrl: string;
  jwtSecret?: string;
  jwtPrivateKey?: string;
  fetchImpl?: typeof fetch;
  /**
   * Comma-separated model ids expected to serve `premium`, e.g.
   * `CV_BENCHMARK_PREMIUM_MODELS=anthropic/claude-sonnet-4-6`. Empty/undefined means
   * "upstream premium support is not configured for this run" — see `PremiumNotConfiguredError`.
   */
  premiumModels?: readonly string[];
}

export class BenchmarkAiClientService {
  private readonly aiServiceUrl: string;
  private readonly jwtSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly premiumModels: readonly string[];
  private readonly jwtPrivateKey: string;

  constructor(options: BenchmarkAiClientOptions) {
    this.aiServiceUrl = options.aiServiceUrl;
    this.jwtSecret = options.jwtSecret ?? '';
    this.jwtPrivateKey = options.jwtPrivateKey ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.premiumModels = options.premiumModels ?? [];
  }

  /** Whether this run is configured to attempt `premium` at all — checked before spending
   * a real call, so an unconfigured run reports "skipped" rather than a network error. */
  supportsTier(tier: BenchmarkTier): boolean {
    return tier !== 'premium' || this.premiumModels.length > 0;
  }

  private expectedModelsFor(tier: BenchmarkTier): readonly string[] {
    if (tier === 'premium') return this.premiumModels;
    return FREE_TIER_MODELS[tier];
  }

  async complete(input: BenchmarkCompletionRequest): Promise<BenchmarkCompletion> {
    if (input.tier === 'premium' && this.premiumModels.length === 0) {
      throw new PremiumNotConfiguredError();
    }

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
          system_prompt: pseudonymizePrompt(input.systemPrompt),
          user_prompt: pseudonymizePrompt(this.withSchema(input.userPrompt, input.outputSchema)),
          output_schema: input.outputSchema,
          max_tokens: input.maxTokens ?? 8000,
          correlation_id: input.correlationId,
          human_approval: input.tier === 'premium' ? (input.humanApproval ?? true) : undefined,
        }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`ai-microservice request failed for tier ${input.tier}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new Error(`ai-microservice returned ${response.status} for tier ${input.tier}: ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      text?: string;
      model_used?: string;
      tier_used?: string;
      model_resolved?: boolean;
      served_by_fallback?: boolean;
      error_code?: string;
      error_message?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      cost?: number;
      cost_usd?: number;
    };

    if (payload.error_code) {
      throw new Error(
        `ai-microservice error ${payload.error_code} for tier ${input.tier}: ${(payload.error_message ?? '').slice(0, 300)}`,
      );
    }

    const text = payload.text ?? '';
    if (text.trim().length === 0) {
      throw new Error(`ai-microservice returned an empty completion for tier ${input.tier}`);
    }

    const modelUsed = payload.model_used ?? 'unknown';
    const modelResolved = payload.model_resolved !== false;
    const servedByFallback = payload.served_by_fallback === true;
    const degraded = !modelResolved || servedByFallback || !this.expectedModelsFor(input.tier).includes(modelUsed);

    return {
      text,
      modelUsed,
      degraded,
      latencyMs,
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
      totalTokens: payload.usage?.total_tokens ?? null,
      costUsd: payload.cost_usd ?? payload.cost ?? null,
    };
  }

  private withSchema(prompt: string, schema?: Record<string, unknown>): string {
    if (!schema) return prompt;
    return `${prompt}\n\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}`;
  }

  private mintServiceToken(): string {
    if (this.jwtPrivateKey) {
      const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const now = Math.floor(Date.now() / 1000);
      const payload = base64url(
        JSON.stringify({ serviceId: SERVICE_ID, iss: TOKEN_ISSUER, iat: now, exp: now + TOKEN_TTL_SECONDS }),
      );
      const signature = base64url(
        createSign('RSA-SHA256').update(`${header}.${payload}`).sign(this.jwtPrivateKey),
      );
      return `${header}.${payload}.${signature}`;
    }

    if (!this.jwtSecret) {
      throw new Error('CV_AI_JWT_SECRET or CV_AI_JWT_PRIVATE_KEY is not set; cannot authenticate to ai-microservice');
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
