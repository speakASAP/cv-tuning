import { Injectable, Logger } from '@nestjs/common';
import { AiClientService } from '../ai/ai-client.service';
import { parseJsonCompletion, requireArray } from '../ai/json-completion';
import {
  buildScreeningPrompt,
  SCREENING_OUTPUT_SCHEMA,
  SCREENING_PROMPT_VERSION,
  SCREENING_SYSTEM_PROMPT,
  ScreeningPromptInput,
} from './screening.prompt';
import { DroppedParagraph } from './supplement.types';
import { DraftBullet } from './tailor.service';

export interface ScreeningAnswerDraft {
  question: string;
  paragraphs: DraftBullet[];
  droppedParagraphs: DroppedParagraph[];
}

export interface ScreeningResult {
  answers: ScreeningAnswerDraft[];
  /** Drops not attributable to one question — chiefly answers to questions nobody asked. */
  droppedParagraphs: DroppedParagraph[];
  modelUsed: string;
  promptVersion: string;
}

interface RawAnswer {
  question?: unknown;
  paragraphs?: unknown;
}

interface RawParagraph {
  text?: unknown;
  sourceFactId?: unknown;
}

/**
 * Normalised key for matching the model's echoed question back to the one that was asked.
 *
 * Models reformat: they re-case, re-space, and add or drop a trailing `?`. Matching strictly
 * would silently blank every answer while the pipeline reported success — the exact class of
 * failure that hides for weeks. None of this normalisation reaches the user: the question text
 * returned is always the one the user or the posting supplied.
 */
function questionKey(question: string): string {
  return question.replace(/\s+/g, ' ').trim().replace(/\?+$/, '').toLowerCase();
}

/**
 * Layer 1 of grounding (spec §6) for screening answers.
 *
 * The one structural difference from `CoverLetterService`: `sourceFactId` uniqueness is scoped
 * PER QUESTION, not across the whole response. Two different questions legitimately draw on
 * the same achievement — "why us" and "describe your PostgreSQL experience" can honestly cite
 * one fact — while the same fact twice within one answer is still fabrication by division.
 *
 * Every asked question is returned, always, even with no paragraphs. Silently omitting an
 * unanswerable one would leave the user to discover the gap on the employer's own form.
 */
@Injectable()
export class ScreeningService {
  private readonly logger = new Logger(ScreeningService.name);

  constructor(private readonly ai: AiClientService) {}

  async generate(input: ScreeningPromptInput): Promise<ScreeningResult> {
    if (input.questions.length === 0) {
      return this.empty([]);
    }

    if (input.facts.length === 0) {
      // Nothing to ground an answer in. Calling the model here could only produce invention,
      // and this is the output the user pastes under their own name.
      this.logger.warn(
        `screening answers requested for a CV with no facts; returning ${input.questions.length} unanswered questions`,
      );
      return this.empty(input.questions);
    }

    // ONE call for all questions: they share the same fact set, so N calls would N-fold the
    // cost and the timeout exposure for no grounding benefit.
    const completion = await this.ai.complete({
      tier: 'smart',
      systemPrompt: SCREENING_SYSTEM_PROMPT,
      userPrompt: buildScreeningPrompt(input),
      outputSchema: SCREENING_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });

    if (completion.degraded) {
      throw new Error(
        `screening answer generation ran on a degraded model (${completion.modelUsed}); ` +
          'refusing to produce answers',
      );
    }

    const parsed = parseJsonCompletion(completion.text, 'screening', this.logger);
    const raw = requireArray(parsed, 'answers', 'screening') as RawAnswer[];

    const knownFactIds = new Set(input.facts.map((f) => f.factId));
    const droppedParagraphs: DroppedParagraph[] = [];

    // Built from the ASKED questions, never from the model's reply, so the result always has
    // one entry per question in the order they were asked.
    const answers = new Map<string, ScreeningAnswerDraft>(
      input.questions.map((question) => [
        questionKey(question),
        { question, paragraphs: [], droppedParagraphs: [] },
      ]),
    );

    for (const candidate of raw) {
      const echoed = typeof candidate.question === 'string' ? candidate.question : '';
      const answer = answers.get(questionKey(echoed));

      if (!answer) {
        // An answer to a question nobody asked would be shown to the user as though the
        // employer had posed it. Dropped loudly, never rendered.
        const paragraphs = Array.isArray(candidate.paragraphs) ? candidate.paragraphs : [];
        for (const paragraph of paragraphs as RawParagraph[]) {
          droppedParagraphs.push({
            text: typeof paragraph.text === 'string' ? paragraph.text : '',
            reason: `answer given to a question that was not asked: "${echoed}"`,
          });
        }
        continue;
      }

      // Scoped per question: the same fact may answer a DIFFERENT question honestly.
      const usedFactIds = new Set<string>();

      for (const paragraph of (Array.isArray(candidate.paragraphs)
        ? candidate.paragraphs
        : []) as RawParagraph[]) {
        const text = typeof paragraph.text === 'string' ? paragraph.text.trim() : '';
        const sourceFactId =
          typeof paragraph.sourceFactId === 'string' ? paragraph.sourceFactId.trim() : '';

        if (!text) {
          answer.droppedParagraphs.push({ text: '', reason: 'paragraph had no text' });
          continue;
        }

        if (!sourceFactId) {
          answer.droppedParagraphs.push({ text, reason: 'paragraph cited no source fact' });
          continue;
        }

        if (!knownFactIds.has(sourceFactId)) {
          answer.droppedParagraphs.push({
            text,
            reason: `paragraph cited unknown source fact "${sourceFactId}"`,
          });
          continue;
        }

        if (usedFactIds.has(sourceFactId)) {
          answer.droppedParagraphs.push({
            text,
            reason: `source fact "${sourceFactId}" was already used in this answer`,
          });
          continue;
        }

        usedFactIds.add(sourceFactId);
        answer.paragraphs.push({ text, sourceFactId, targetRequirement: null });
      }
    }

    const result = [...answers.values()];

    for (const answer of result) {
      for (const dropped of answer.droppedParagraphs) {
        this.logger.error(
          `dropped screening paragraph for "${answer.question}": ${dropped.reason}; text="${dropped.text}"`,
        );
      }
      if (answer.paragraphs.length === 0) {
        // Not an error: an unanswerable question is real signal for the user. Logged so the
        // gap is visible in operations too, rather than only in the UI.
        this.logger.warn(`no grounded answer for screening question "${answer.question}"`);
      }
    }

    for (const dropped of droppedParagraphs) {
      this.logger.error(`dropped screening paragraph: ${dropped.reason}; text="${dropped.text}"`);
    }

    return {
      answers: result,
      droppedParagraphs,
      modelUsed: completion.modelUsed,
      promptVersion: SCREENING_PROMPT_VERSION,
    };
  }

  /** Every asked question, present and unanswered. Never an empty list where questions exist. */
  private empty(questions: string[]): ScreeningResult {
    return {
      answers: questions.map((question) => ({
        question,
        paragraphs: [],
        droppedParagraphs: [],
      })),
      droppedParagraphs: [],
      modelUsed: '',
      promptVersion: SCREENING_PROMPT_VERSION,
    };
  }
}
