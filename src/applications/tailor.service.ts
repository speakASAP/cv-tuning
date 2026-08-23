import { Injectable, Logger } from '@nestjs/common';
import { AiClientService } from '../ai/ai-client.service';
import {
  buildTailorPrompt,
  TAILOR_OUTPUT_SCHEMA,
  TAILOR_PROMPT_VERSION,
  TAILOR_SYSTEM_PROMPT,
  TailorPromptInput,
} from './tailor.prompt';

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

export interface DraftBullet {
  text: string;
  sourceFactId: string;
  targetRequirement: string | null;
}

export interface TailorResult {
  bullets: DraftBullet[];
  /** Bullets the source constraint rejected. Kept so a drop is diagnosable, never invisible. */
  droppedBullets: { text: string; reason: string }[];
  modelUsed: string;
  promptVersion: string;
}

interface RawBullet {
  text?: unknown;
  sourceFactId?: unknown;
  targetRequirement?: unknown;
}

/**
 * Layer 1 of grounding (spec §6): constrained generation.
 *
 * The prompt asks for a one-to-one rewrite; this service *enforces* it. The prompt is a
 * request, the code is the guarantee — a bullet whose source fact does not exist cannot be
 * validated by anything downstream, so it never reaches the user.
 */
@Injectable()
export class TailorService {
  private readonly logger = new Logger(TailorService.name);

  constructor(private readonly ai: AiClientService) {}

  async tailor(input: TailorPromptInput): Promise<TailorResult> {
    if (input.facts.length === 0) {
      // Nothing to rewrite. Calling the model here could only produce invention.
      this.logger.warn('tailoring requested for a CV with no facts; returning no bullets');
      return { bullets: [], droppedBullets: [], modelUsed: '', promptVersion: TAILOR_PROMPT_VERSION };
    }

    const completion = await this.ai.complete({
      tier: 'smart',
      systemPrompt: TAILOR_SYSTEM_PROMPT,
      userPrompt: buildTailorPrompt(input),
      outputSchema: TAILOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });

    if (completion.degraded) {
      // A tailored CV written by a downgraded model is precisely the auto-rejected output
      // this product exists to prevent. Refusing beats shipping it silently.
      throw new Error(
        `tailoring ran on a degraded model (${completion.modelUsed}); refusing to produce a render`,
      );
    }

    const raw = this.parseBullets(completion.text);
    const knownFactIds = new Set(input.facts.map((f) => f.factId));
    const usedFactIds = new Set<string>();

    const bullets: DraftBullet[] = [];
    const droppedBullets: { text: string; reason: string }[] = [];

    for (const candidate of raw) {
      const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
      const sourceFactId =
        typeof candidate.sourceFactId === 'string' ? candidate.sourceFactId.trim() : '';

      if (!text) {
        droppedBullets.push({ text: '', reason: 'bullet had no text' });
        continue;
      }

      if (!sourceFactId) {
        droppedBullets.push({ text, reason: 'bullet cited no source fact' });
        continue;
      }

      if (!knownFactIds.has(sourceFactId)) {
        droppedBullets.push({ text, reason: `bullet cited unknown source fact "${sourceFactId}"` });
        continue;
      }

      if (usedFactIds.has(sourceFactId)) {
        // Splitting one fact across two bullets manufactures two claims from evidence that
        // supports one, which is fabrication by division.
        droppedBullets.push({ text, reason: `source fact "${sourceFactId}" was already used` });
        continue;
      }

      usedFactIds.add(sourceFactId);
      bullets.push({
        text,
        sourceFactId,
        targetRequirement:
          typeof candidate.targetRequirement === 'string' && candidate.targetRequirement.trim()
            ? candidate.targetRequirement.trim()
            : null,
      });
    }

    for (const dropped of droppedBullets) {
      this.logger.error(`dropped tailored bullet: ${dropped.reason}; text="${dropped.text}"`);
    }

    return {
      bullets,
      droppedBullets,
      modelUsed: completion.modelUsed,
      promptVersion: TAILOR_PROMPT_VERSION,
    };
  }

  private parseBullets(text: string): RawBullet[] {
    const unfenced = FENCE.exec(text)?.[1] ?? text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(unfenced);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`failed to parse tailoring response: ${message}; body=${text.slice(0, 300)}`);
      throw new Error(`could not parse tailoring response: ${message}`);
    }

    const bullets = (parsed as { bullets?: unknown }).bullets;
    if (!Array.isArray(bullets)) {
      throw new Error('tailoring response has no bullets array');
    }

    return bullets as RawBullet[];
  }
}
