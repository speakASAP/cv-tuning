import { Injectable, Logger } from '@nestjs/common';
import { AiClientService } from '../ai/ai-client.service';
import {
  buildRevisePrompt,
  REVISE_PROMPT_VERSION,
  REVISE_SYSTEM_PROMPT,
  RevisePromptInput,
} from './revise.prompt';
import { TAILOR_OUTPUT_SCHEMA } from './tailor.prompt';
import { DraftBullet, TailorResult } from './tailor.service';

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

interface RawBullet {
  text?: unknown;
  sourceFactId?: unknown;
  targetRequirement?: unknown;
}

/**
 * A revision turn is layer 1 of grounding applied again (spec §6), not a lighter path.
 *
 * The user's instruction is untrusted input: it can ask for a claim the facts do not
 * support. The prompt refuses; this service enforces, exactly as TailorService does for the
 * first generation. Returning `TailorResult` keeps the pipeline downstream identical.
 */
@Injectable()
export class ReviseService {
  private readonly logger = new Logger(ReviseService.name);

  constructor(private readonly ai: AiClientService) {}

  async revise(input: RevisePromptInput): Promise<TailorResult> {
    const completion = await this.ai.complete({
      tier: 'smart',
      systemPrompt: REVISE_SYSTEM_PROMPT,
      userPrompt: buildRevisePrompt(input),
      outputSchema: TAILOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });

    if (completion.degraded) {
      // A fallback model still returns well-formed prose, so this cannot be detected
      // downstream. Refuse rather than quietly ship worse grounding (spec §8.1).
      this.logger.error(`revision served by unexpected model ${completion.modelUsed}; refusing`);
      throw new Error(`revision was degraded: served by ${completion.modelUsed}`);
    }

    const parsed = this.parse(completion.text);
    const known = new Set(input.facts.map((f) => f.factId));
    const bullets: DraftBullet[] = [];
    const droppedBullets: { text: string; reason: string }[] = [];

    for (const raw of parsed) {
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      const sourceFactId = typeof raw.sourceFactId === 'string' ? raw.sourceFactId : '';

      if (!text || !sourceFactId) {
        droppedBullets.push({ text, reason: 'bullet is missing text or sourceFactId' });
        continue;
      }

      if (!known.has(sourceFactId)) {
        // The source constraint is the guarantee, not the prompt. A bullet citing a fact we
        // do not have cannot be validated by anything downstream.
        droppedBullets.push({ text, reason: `cites unknown source fact "${sourceFactId}"` });
        continue;
      }

      bullets.push({
        text,
        sourceFactId,
        targetRequirement: typeof raw.targetRequirement === 'string' ? raw.targetRequirement : null,
      });
    }

    if (droppedBullets.length > 0) {
      this.logger.warn(`revision dropped ${droppedBullets.length} bullet(s) failing the source constraint`);
    }

    return {
      bullets,
      droppedBullets,
      modelUsed: completion.modelUsed,
      promptVersion: REVISE_PROMPT_VERSION,
    };
  }

  private parse(text: string): RawBullet[] {
    const unfenced = FENCE.exec(text.trim())?.[1] ?? text.trim();
    let payload: { bullets?: unknown };
    try {
      payload = JSON.parse(unfenced) as { bullets?: unknown };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`could not parse revision output: ${message}; raw=${text.slice(0, 300)}`);
      throw new Error(`could not parse revision output as JSON: ${message}`);
    }

    if (!Array.isArray(payload.bullets)) {
      this.logger.error(`revision output has no bullets array; raw=${text.slice(0, 300)}`);
      throw new Error('revision output did not contain a bullets array');
    }

    return payload.bullets as RawBullet[];
  }
}
