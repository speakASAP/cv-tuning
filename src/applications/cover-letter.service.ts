import { Injectable, Logger } from '@nestjs/common';
import { AiClientService } from '../ai/ai-client.service';
import { parseJsonCompletion, requireArray } from '../ai/json-completion';
import {
  buildCoverLetterPrompt,
  COVER_LETTER_OUTPUT_SCHEMA,
  COVER_LETTER_PROMPT_VERSION,
  COVER_LETTER_SYSTEM_PROMPT,
  CoverLetterPromptInput,
} from './cover-letter.prompt';
import { DroppedParagraph } from './supplement.types';
import { DraftBullet } from './tailor.service';

export interface CoverLetterResult {
  /**
   * Deliberately `DraftBullet`: a cover-letter paragraph and a tailored bullet are the same
   * shape of claim, which is what lets `EntailService.validate()` serve both without a second
   * implementation of the grounding core.
   */
  paragraphs: DraftBullet[];
  /** Paragraphs the source constraint rejected. Kept so a drop is diagnosable, never invisible. */
  droppedParagraphs: DroppedParagraph[];
  modelUsed: string;
  promptVersion: string;
}

interface RawParagraph {
  text?: unknown;
  sourceFactId?: unknown;
  targetRequirement?: unknown;
}

/**
 * Layer 1 of grounding (spec §6) for cover letters: constrained generation.
 *
 * Structurally parallel to `TailorService` and enforcing the identical source constraint. The
 * prompt asks for a one-to-one binding; this service *guarantees* it — the prompt is a request,
 * the code is the guarantee. A paragraph whose source fact does not exist cannot be validated
 * by anything downstream, so it never reaches the user.
 */
@Injectable()
export class CoverLetterService {
  private readonly logger = new Logger(CoverLetterService.name);

  constructor(private readonly ai: AiClientService) {}

  async generate(input: CoverLetterPromptInput): Promise<CoverLetterResult> {
    if (input.facts.length === 0) {
      // Nothing to ground a letter in. Calling the model here could only produce invention.
      this.logger.warn('cover letter requested for a CV with no facts; returning no paragraphs');
      return {
        paragraphs: [],
        droppedParagraphs: [],
        modelUsed: '',
        promptVersion: COVER_LETTER_PROMPT_VERSION,
      };
    }

    const completion = await this.ai.complete({
      tier: 'smart',
      systemPrompt: COVER_LETTER_SYSTEM_PROMPT,
      userPrompt: buildCoverLetterPrompt(input),
      outputSchema: COVER_LETTER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });

    if (completion.degraded) {
      // A cover letter written by a downgraded model is precisely the auto-rejected output
      // this product exists to prevent. Refusing beats shipping it silently.
      throw new Error(
        `cover letter generation ran on a degraded model (${completion.modelUsed}); ` +
          'refusing to produce a letter',
      );
    }

    const parsed = parseJsonCompletion(completion.text, 'cover letter', this.logger);
    const raw = requireArray(parsed, 'paragraphs', 'cover letter') as RawParagraph[];

    const knownFactIds = new Set(input.facts.map((f) => f.factId));
    const usedFactIds = new Set<string>();

    const paragraphs: DraftBullet[] = [];
    const droppedParagraphs: DroppedParagraph[] = [];

    for (const candidate of raw) {
      const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
      const sourceFactId =
        typeof candidate.sourceFactId === 'string' ? candidate.sourceFactId.trim() : '';

      if (!text) {
        droppedParagraphs.push({ text: '', reason: 'paragraph had no text' });
        continue;
      }

      if (!sourceFactId) {
        droppedParagraphs.push({ text, reason: 'paragraph cited no source fact' });
        continue;
      }

      if (!knownFactIds.has(sourceFactId)) {
        droppedParagraphs.push({
          text,
          reason: `paragraph cited unknown source fact "${sourceFactId}"`,
        });
        continue;
      }

      if (usedFactIds.has(sourceFactId)) {
        // Splitting one fact across two paragraphs manufactures two claims from evidence that
        // supports one, which is fabrication by division.
        droppedParagraphs.push({ text, reason: `source fact "${sourceFactId}" was already used` });
        continue;
      }

      usedFactIds.add(sourceFactId);
      paragraphs.push({
        text,
        sourceFactId,
        targetRequirement:
          typeof candidate.targetRequirement === 'string' && candidate.targetRequirement.trim()
            ? candidate.targetRequirement.trim()
            : null,
      });
    }

    for (const dropped of droppedParagraphs) {
      this.logger.error(`dropped cover letter paragraph: ${dropped.reason}; text="${dropped.text}"`);
    }

    return {
      paragraphs,
      droppedParagraphs,
      modelUsed: completion.modelUsed,
      promptVersion: COVER_LETTER_PROMPT_VERSION,
    };
  }
}
