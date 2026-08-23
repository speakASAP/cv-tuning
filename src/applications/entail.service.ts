import { Injectable, Logger } from '@nestjs/common';
import { AiClientService } from '../ai/ai-client.service';
import { EntailmentVerdict, FactSnapshot, TailoredBullet } from './application.types';
import {
  buildEntailPrompt,
  ENTAIL_OUTPUT_SCHEMA,
  ENTAIL_PROMPT_VERSION,
  ENTAIL_SYSTEM_PROMPT,
} from './entail.prompt';
import { DraftBullet } from './tailor.service';

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

export interface EntailResult {
  bullets: TailoredBullet[];
  validatorModelUsed: string;
  validatorPromptVersion: string;
}

interface RawResult {
  bulletRef?: unknown;
  verdict?: unknown;
  span?: unknown;
}

/**
 * Layer 2 of grounding (spec §6): entailment validation.
 *
 * A separate LLM call with its own prompt and schema, deliberately not the same call that
 * wrote the bullets — a model grading its own output is not validation. Shape copied from
 * the house validator at `ai-microservice/src/teacher-assistant/validate.service.ts`,
 * including its rule that a downgrade must never destroy the reason for it.
 */
@Injectable()
export class EntailService {
  private readonly logger = new Logger(EntailService.name);

  constructor(private readonly ai: AiClientService) {}

  async validate(bullets: DraftBullet[], facts: FactSnapshot[]): Promise<EntailResult> {
    if (bullets.length === 0) {
      return { bullets: [], validatorModelUsed: '', validatorPromptVersion: ENTAIL_PROMPT_VERSION };
    }

    const factsById = new Map(facts.map((fact) => [fact.factId, fact]));
    const promptBullets = bullets.map((bullet) => {
      const fact = factsById.get(bullet.sourceFactId);
      if (!fact) {
        // TailorService drops these. Arriving here means the source constraint was bypassed;
        // validating against a fact we do not have would be theatre.
        throw new Error(
          `bullet cites source fact "${bullet.sourceFactId}" which is not in the render snapshot`,
        );
      }
      return { text: bullet.text, sourceFactText: fact.text };
    });

    const completion = await this.ai.complete({
      tier: 'smart',
      systemPrompt: ENTAIL_SYSTEM_PROMPT,
      userPrompt: buildEntailPrompt(promptBullets),
      outputSchema: ENTAIL_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });

    if (completion.degraded) {
      throw new Error(
        `entailment validation ran on a degraded model (${completion.modelUsed}); refusing to report verdicts`,
      );
    }

    const byRef = new Map<number, RawResult>();
    for (const raw of this.parseResults(completion.text)) {
      if (typeof raw.bulletRef === 'number' && raw.bulletRef >= 0 && raw.bulletRef < bullets.length) {
        byRef.set(raw.bulletRef, raw);
      } else {
        this.logger.error(`validator returned an out-of-range bulletRef ${String(raw.bulletRef)}; ignoring it`);
      }
    }

    const validated = bullets.map((bullet, index) => this.toValidated(bullet, byRef.get(index)));

    return {
      bullets: validated,
      validatorModelUsed: completion.modelUsed,
      validatorPromptVersion: ENTAIL_PROMPT_VERSION,
    };
  }

  private toValidated(bullet: DraftBullet, raw: RawResult | undefined): TailoredBullet {
    if (!raw) {
      // Fail closed: an unvalidated claim must never be presented as validated.
      this.logger.error(`validator skipped bullet "${bullet.text}"; treating it as unsupported`);
      return { ...bullet, verdict: 'unsupported', span: bullet.text };
    }

    const verdict: EntailmentVerdict =
      raw.verdict === 'supported' || raw.verdict === 'overreach' || raw.verdict === 'unsupported'
        ? raw.verdict
        : 'unsupported';

    if (verdict !== raw.verdict) {
      this.logger.error(
        `validator returned unrecognised verdict ${JSON.stringify(raw.verdict)} for "${bullet.text}"; treating as unsupported`,
      );
    }

    if (verdict === 'supported') {
      return { ...bullet, verdict, span: null };
    }

    // A downgrade must never destroy the reason for it: synthesize a span when the model
    // gave none, so the review UI can still show the user what to confirm or drop.
    const span = typeof raw.span === 'string' && raw.span.trim() ? raw.span.trim() : bullet.text;

    return { ...bullet, verdict, span };
  }

  private parseResults(text: string): RawResult[] {
    const unfenced = FENCE.exec(text)?.[1] ?? text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(unfenced);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`failed to parse entailment response: ${message}; body=${text.slice(0, 300)}`);
      throw new Error(`could not parse entailment response: ${message}`);
    }

    const results = (parsed as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new Error('entailment response has no results array');
    }

    return results as RawResult[];
  }
}
