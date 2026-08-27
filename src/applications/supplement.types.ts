import { EntailmentVerdict } from './application.types';

/**
 * The application materials that are not the CV itself.
 *
 * Phase 6 adds no new grounding machinery for these. `EntailService.validate()` is already
 * generic over "claims bound to facts", so a cover-letter paragraph and a screening answer are
 * both a claim with a `sourceFactId` and get layer 2 unchanged — there is no second
 * implementation of the anti-fabrication core to keep in sync with the first.
 */
export const SUPPLEMENT_KINDS = ['cover_letter', 'screening'] as const;
export type SupplementKind = (typeof SUPPLEMENT_KINDS)[number];

/**
 * Where a screening question came from, kept on the row rather than inferred later.
 *
 * `user` is a question the applicant pasted from a real application portal. `parsed` is one
 * this service extracted from the job posting, which is a guess about what will be asked.
 * They have different reliability and MUST stay distinguishable: presenting a guessed question
 * as one the employer actually asked would have the user answer a question nobody posed, and
 * that answer would go out as though it were solicited.
 */
export const QUESTION_SOURCES = ['user', 'parsed'] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

/**
 * One model-authored paragraph, bound to exactly one master fact.
 *
 * Deliberately the same shape as `TailoredBullet` minus its `bulletId`: the binding is what
 * layer 2 validates, so a paragraph that carried two source facts (or none) would be a claim
 * the validator cannot check. Prose is longer than a bullet but is not a different kind of
 * assertion.
 *
 * Connective sentences that no fact supports — a salutation, the line naming the role and
 * company, a closing — are NOT paragraphs and never appear here. They are built in code from
 * the parsed job (see `cover-letter.assemble.ts`), which is what lets the "every model-authored
 * sentence binds to exactly one fact" rule keep no carve-out and the validator need no
 * "not a claim" verdict.
 */
export interface CoverLetterParagraph {
  text: string;
  sourceFactId: string;
  /** The job requirement this paragraph is aimed at, or null when it addresses none specifically. */
  targetRequirement: string | null;
  verdict: EntailmentVerdict;
  /** The offending span when the verdict is not `supported`. Never null for a non-supported verdict. */
  span: string | null;
}

/** A paragraph the source constraint or the validator rejected, kept so a drop is diagnosable. */
export interface DroppedParagraph {
  text: string;
  reason: string;
}

export interface ScreeningAnswer {
  question: string;
  questionSource: QuestionSource;
  paragraphs: CoverLetterParagraph[];
  droppedParagraphs: DroppedParagraph[];
}

/**
 * What was actually produced, including what was thrown away.
 *
 * `droppedParagraphs` is not optional. A generation that silently emitted three paragraphs
 * where the model wrote five would look identical to one where the model wrote three, and the
 * difference — two ungrounded claims caught — is the thing this product exists to record.
 */
export interface SupplementProvenance {
  paragraphs: CoverLetterParagraph[];
  droppedParagraphs: DroppedParagraph[];
  /** Present only for `kind = 'screening'`; a cover letter has no questions. */
  answers?: ScreeningAnswer[];
}
